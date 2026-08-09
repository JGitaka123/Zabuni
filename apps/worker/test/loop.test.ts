import type { OutboxStallSnapshot } from "@zabuni/db/privileged/outbox";
import type { ErrorReporter, StructuredLogger } from "@zabuni/observability";
import { describe, expect, it } from "vitest";

import { OutboxDrainLoop, waitForDatabase, type DrainLoopStore } from "../src/loop.js";
import { OutboxDrainWorker, type OutboxClaim, type OutboxRepository } from "../src/outbox.js";

interface LoggedEvent {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly attributes: Readonly<Record<string, unknown>> | undefined;
}

function createTelemetry(): {
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
  readonly events: LoggedEvent[];
  readonly captured: unknown[];
} {
  const events: LoggedEvent[] = [];
  const captured: unknown[] = [];
  const record =
    (level: LoggedEvent["level"]) =>
    (event: string, _context: unknown, attributes?: Readonly<Record<string, unknown>>): void => {
      events.push({ level, event, attributes });
    };
  return {
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error")
    },
    errors: {
      enabled: true,
      capture: (error: unknown): string | undefined => {
        captured.push(error);
        return undefined;
      }
    },
    events,
    captured
  };
}

const emptySnapshot: OutboxStallSnapshot = {
  expiredLeases: 0,
  exhaustedLeases: 0,
  oldestExpiredSeconds: 0
};

function createClaim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    id: "0192f2a0-0000-7000-8000-000000000001",
    tenantId: "0192f2a0-0000-7000-8000-0000000000ff",
    eventType: "fixture.delivery",
    payloadVersion: 1,
    payload: {},
    idempotencyKey: "key-1",
    attemptCount: 1,
    maxAttempts: 5,
    claimedBy: "worker-test",
    claimToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    claimExpiresAt: new Date("2099-01-01T00:00:00Z"),
    ...overrides
  };
}

/** Repository whose claim behaviour is scripted per iteration. */
function scriptedRepository(script: readonly (readonly OutboxClaim[] | Error)[]): OutboxRepository {
  let index = 0;
  return {
    claim: () => {
      const step = script[Math.min(index, script.length - 1)];
      index++;
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step ?? []);
    },
    markSent: () => Promise.resolve(true),
    markFailed: () => Promise.resolve(true)
  };
}

function stubStore(snapshot: OutboxStallSnapshot = emptySnapshot): DrainLoopStore {
  return {
    stallSnapshot: () => Promise.resolve(snapshot),
    ping: () => Promise.resolve()
  };
}

describe("OutboxDrainLoop", () => {
  it("polls until stopped and reports totals", async () => {
    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(
      scriptedRepository([[createClaim()], [createClaim({ idempotencyKey: "key-2" })], []]),
      [
        {
          eventType: "fixture.delivery",
          payloadVersion: 1,
          send: () => Promise.resolve({ resultRef: "fixture:ok" })
        }
      ],
      telemetry
    );

    let sleeps = 0;
    const loop = new OutboxDrainLoop(worker, stubStore(), {
      workerId: "worker-test",
      pollIntervalMs: 1,
      idlePollIntervalMs: 2,
      leaseSeconds: 60,
      sleep: () => {
        sleeps++;
        if (sleeps >= 3) void loop.stop();
        return Promise.resolve();
      },
      now: () => 0
    });

    const totals = await loop.start();
    expect(totals.sent).toBe(2);
    expect(totals.claimed).toBe(2);
    expect(totals.drainErrors).toBe(0);
    expect(loop.running).toBe(false);
  });

  it("uses the idle interval when no work was claimed", async () => {
    const worker = new OutboxDrainWorker(scriptedRepository([[]]), [], createTelemetry());
    const delays: number[] = [];
    const loop = new OutboxDrainLoop(worker, stubStore(), {
      workerId: "worker-test",
      pollIntervalMs: 10,
      idlePollIntervalMs: 500,
      leaseSeconds: 60,
      sleep: (ms) => {
        delays.push(ms);
        void loop.stop();
        return Promise.resolve();
      },
      now: () => 0
    });

    await loop.start();
    expect(delays).toEqual([500]);
  });

  it("survives a drain failure and backs off instead of exiting", async () => {
    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(
      scriptedRepository([new Error("connection reset")]),
      [],
      telemetry
    );
    const delays: number[] = [];
    const loop = new OutboxDrainLoop(
      worker,
      stubStore(),
      {
        workerId: "worker-test",
        pollIntervalMs: 100,
        idlePollIntervalMs: 500,
        leaseSeconds: 60,
        sleep: (ms) => {
          delays.push(ms);
          void loop.stop();
          return Promise.resolve();
        },
        now: () => 0
      },
      telemetry
    );

    const totals = await loop.start();
    expect(totals.drainErrors).toBe(1);
    expect(delays).toEqual([100]);
    expect(telemetry.events.some((entry) => entry.event === "drain_iteration_failed")).toBe(true);
    expect(telemetry.captured).toHaveLength(1);
  });

  it("raises a crash-loop alert when leases expire with no attempts left", async () => {
    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(scriptedRepository([[]]), [], telemetry);
    const loop = new OutboxDrainLoop(
      worker,
      stubStore({ expiredLeases: 3, exhaustedLeases: 2, oldestExpiredSeconds: 900 }),
      {
        workerId: "worker-test",
        pollIntervalMs: 1,
        idlePollIntervalMs: 1,
        leaseSeconds: 60,
        sleep: () => {
          void loop.stop();
          return Promise.resolve();
        },
        now: () => 0
      },
      telemetry
    );

    await loop.start();
    const alert = telemetry.events.find((entry) => entry.event === "outbox_crash_loop_suspected");
    expect(alert?.level).toBe("error");
    expect(alert?.attributes?.exhaustedLeases).toBe(2);
    expect(telemetry.captured).toHaveLength(1);
  });

  it("warns without alerting when leases expired but attempts remain", async () => {
    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(scriptedRepository([[]]), [], telemetry);
    const loop = new OutboxDrainLoop(
      worker,
      stubStore({ expiredLeases: 1, exhaustedLeases: 0, oldestExpiredSeconds: 12 }),
      {
        workerId: "worker-test",
        pollIntervalMs: 1,
        idlePollIntervalMs: 1,
        leaseSeconds: 60,
        sleep: () => {
          void loop.stop();
          return Promise.resolve();
        },
        now: () => 0
      },
      telemetry
    );

    await loop.start();
    expect(telemetry.events.some((entry) => entry.event === "outbox_lease_expired")).toBe(true);
    expect(telemetry.events.some((entry) => entry.event === "outbox_crash_loop_suspected")).toBe(
      false
    );
    expect(telemetry.captured).toHaveLength(0);
  });

  it("does not let a stall-check failure kill the loop", async () => {
    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(scriptedRepository([[]]), [], telemetry);
    const loop = new OutboxDrainLoop(
      worker,
      {
        stallSnapshot: () => Promise.reject(new Error("permission denied")),
        ping: () => Promise.resolve()
      },
      {
        workerId: "worker-test",
        pollIntervalMs: 1,
        idlePollIntervalMs: 1,
        leaseSeconds: 60,
        sleep: () => {
          void loop.stop();
          return Promise.resolve();
        },
        now: () => 0
      },
      telemetry
    );

    const totals = await loop.start();
    expect(totals.iterations).toBe(1);
    expect(telemetry.events.some((entry) => entry.event === "outbox_stall_check_failed")).toBe(
      true
    );
  });

  it("finishes the in-flight delivery before stopping", async () => {
    let released: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      released = resolve;
    });
    let delivered = false;

    const telemetry = createTelemetry();
    const worker = new OutboxDrainWorker(
      scriptedRepository([[createClaim()], []]),
      [
        {
          eventType: "fixture.delivery",
          payloadVersion: 1,
          send: async () => {
            await inFlight;
            delivered = true;
            return { resultRef: "fixture:ok" };
          }
        }
      ],
      telemetry
    );

    const loop = new OutboxDrainLoop(worker, stubStore(), {
      workerId: "worker-test",
      pollIntervalMs: 1,
      idlePollIntervalMs: 1,
      leaseSeconds: 60,
      sleep: () => Promise.resolve(),
      now: () => 0
    });

    const finished = loop.start();
    // Request shutdown while the delivery is still suspended.
    const stopped = loop.stop();
    expect(delivered).toBe(false);
    released?.();

    const totals = await stopped;
    await finished;
    expect(delivered).toBe(true);
    expect(totals.sent).toBe(1);
  });

  it("refuses to start twice", () => {
    const worker = new OutboxDrainWorker(scriptedRepository([[]]), [], createTelemetry());
    const loop = new OutboxDrainLoop(worker, stubStore(), {
      workerId: "worker-test",
      pollIntervalMs: 1,
      idlePollIntervalMs: 1,
      leaseSeconds: 60,
      sleep: () => Promise.resolve(),
      now: () => 0
    });
    void loop.start();
    void loop.stop();
    expect(() => loop.start()).toThrow("already started");
  });
});

describe("waitForDatabase", () => {
  it("returns once the database answers", async () => {
    let attempts = 0;
    await waitForDatabase(
      {
        stallSnapshot: () => Promise.resolve(emptySnapshot),
        ping: () => {
          attempts++;
          return attempts < 3 ? Promise.reject(new Error("starting up")) : Promise.resolve();
        }
      },
      { attempts: 5, delayMs: 0, sleep: () => Promise.resolve() }
    );
    expect(attempts).toBe(3);
  });

  it("fails after exhausting its attempts", async () => {
    await expect(
      waitForDatabase(
        {
          stallSnapshot: () => Promise.resolve(emptySnapshot),
          ping: () => Promise.reject(new Error("connection refused"))
        },
        { attempts: 3, delayMs: 0, sleep: () => Promise.resolve() }
      )
    ).rejects.toThrow("Database did not become ready after 3 attempts");
  });
});
