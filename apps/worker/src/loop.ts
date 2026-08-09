import type { OutboxStallSnapshot } from "@zabuni/db/privileged/outbox";

import type { OutboxDrainWorker, WorkerTelemetry } from "./outbox.js";

export interface DrainLoopStore {
  readonly stallSnapshot: (expiredGraceSeconds?: number) => Promise<OutboxStallSnapshot>;
  readonly ping: () => Promise<void>;
}

export interface DrainLoopOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly idlePollIntervalMs: number;
  readonly leaseSeconds: number;
  /** Expired leases older than this are treated as a stalled delivery, not a slow one. */
  readonly stallGraceSeconds?: number;
  /** How often to sample the stall snapshot. */
  readonly stallCheckIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface DrainLoopTotals {
  readonly iterations: number;
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failedPermanent: number;
  readonly stale: number;
  readonly drainErrors: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    // A pending poll timer must not hold the process open during shutdown.
    timer.unref();
  });
}

/**
 * Long-running outbox drain.
 *
 * Polls fast while there is work and backs off to the idle interval when the
 * queue is empty. Stop is cooperative: `stop()` resolves once the in-flight
 * drain has finished, so a claimed row is never abandoned mid-delivery — its
 * lease would otherwise have to expire before another worker could pick it up.
 */
export class OutboxDrainLoop {
  readonly #worker: OutboxDrainWorker;
  readonly #store: DrainLoopStore;
  readonly #options: DrainLoopOptions;
  readonly #telemetry: WorkerTelemetry | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  #running = false;
  #stopping = false;
  #finished: Promise<DrainLoopTotals> | undefined;
  // Negative infinity so the very first iteration samples: a worker starting
  // into an already-stalled queue must alert now, not one interval from now.
  #lastStallCheck = Number.NEGATIVE_INFINITY;
  /** Set when the previous sample already reported a crash-loop, to avoid alert spam. */
  #stallAlerted = false;

  public constructor(
    worker: OutboxDrainWorker,
    store: DrainLoopStore,
    options: DrainLoopOptions,
    telemetry?: WorkerTelemetry
  ) {
    this.#worker = worker;
    this.#store = store;
    this.#options = options;
    this.#telemetry = telemetry;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  public get running(): boolean {
    return this.#running;
  }

  /**
   * Read through a method so control-flow analysis cannot narrow the field to a
   * constant. `stop()` mutates it from outside while the loop is suspended on an
   * await, which narrowing does not model.
   */
  #shouldStop(): boolean {
    return this.#stopping;
  }

  public start(): Promise<DrainLoopTotals> {
    if (this.#finished !== undefined) throw new Error("Drain loop is already started");
    this.#running = true;
    this.#stopping = false;
    this.#finished = this.#run();
    return this.#finished;
  }

  /** Requests shutdown and resolves once the in-flight drain completes. */
  public async stop(): Promise<DrainLoopTotals> {
    this.#stopping = true;
    const finished = this.#finished;
    if (finished === undefined) {
      return {
        iterations: 0,
        claimed: 0,
        sent: 0,
        retried: 0,
        failedPermanent: 0,
        stale: 0,
        drainErrors: 0
      };
    }
    return finished;
  }

  async #run(): Promise<DrainLoopTotals> {
    const totals = {
      iterations: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      failedPermanent: 0,
      stale: 0,
      drainErrors: 0
    };
    // A transient database failure must not kill the process; back off instead.
    let consecutiveErrors = 0;

    try {
      while (!this.#shouldStop()) {
        totals.iterations++;
        let idle = true;

        try {
          const result = await this.#worker.drain({
            workerId: this.#options.workerId,
            leaseSeconds: this.#options.leaseSeconds
          });
          consecutiveErrors = 0;
          totals.claimed += result.claimed;
          totals.sent += result.sent;
          totals.retried += result.retried;
          totals.failedPermanent += result.failedPermanent;
          totals.stale += result.stale;
          idle = result.claimed === 0;
        } catch (error) {
          consecutiveErrors++;
          totals.drainErrors++;
          this.#telemetry?.errors.capture(error, { correlationId: this.#options.workerId });
          this.#telemetry?.logger.error(
            "drain_iteration_failed",
            { correlationId: this.#options.workerId },
            { consecutiveErrors }
          );
        }

        await this.#checkForStall();
        if (this.#shouldStop()) break;

        const backoff = Math.min(consecutiveErrors, 5) * this.#options.pollIntervalMs;
        await this.#sleep(
          consecutiveErrors > 0
            ? backoff
            : idle
              ? this.#options.idlePollIntervalMs
              : this.#options.pollIntervalMs
        );
      }
    } finally {
      this.#running = false;
    }

    return totals;
  }

  async #checkForStall(): Promise<void> {
    const interval = this.#options.stallCheckIntervalMs ?? 60_000;
    const now = this.#now();
    if (now - this.#lastStallCheck < interval) return;
    this.#lastStallCheck = now;

    try {
      const snapshot = await this.#store.stallSnapshot(this.#options.stallGraceSeconds ?? 0);
      if (snapshot.exhaustedLeases > 0) {
        // A row that expired its lease with no attempts left is being reclaimed
        // forever: some worker keeps dying after the external effect. Operators
        // must see this, because idempotency hides it from the delivery result.
        if (!this.#stallAlerted) {
          this.#stallAlerted = true;
          this.#telemetry?.errors.capture(
            new Error("Outbox deliveries are stalled with no attempts remaining"),
            { correlationId: this.#options.workerId }
          );
        }
        this.#telemetry?.logger.error(
          "outbox_crash_loop_suspected",
          { correlationId: this.#options.workerId },
          {
            expiredLeases: snapshot.expiredLeases,
            exhaustedLeases: snapshot.exhaustedLeases,
            oldestExpiredSeconds: snapshot.oldestExpiredSeconds
          }
        );
        return;
      }

      this.#stallAlerted = false;
      if (snapshot.expiredLeases > 0) {
        this.#telemetry?.logger.warn(
          "outbox_lease_expired",
          { correlationId: this.#options.workerId },
          {
            expiredLeases: snapshot.expiredLeases,
            oldestExpiredSeconds: snapshot.oldestExpiredSeconds
          }
        );
      }
    } catch (error) {
      this.#telemetry?.logger.warn(
        "outbox_stall_check_failed",
        { correlationId: this.#options.workerId },
        { error: error instanceof Error ? error.name : "unknown" }
      );
    }
  }
}

/** Blocks until the database answers, so a bad connection fails at boot. */
export async function waitForDatabase(
  store: DrainLoopStore,
  options: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await store.ping();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(
    `Database did not become ready after ${String(attempts)} attempts: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`
  );
}
