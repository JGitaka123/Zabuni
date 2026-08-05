import { describe, expect, it } from "vitest";

import { IdempotentFixtureTransport, fixtureHandler } from "../src/fixture-transport.js";
import {
  OutboxDrainWorker,
  SimulatedWorkerCrash,
  retryDelaySeconds,
  type OutboxClaim,
  type OutboxFailure,
  type OutboxRepository
} from "../src/outbox.js";

type State = "pending" | "processing" | "sent" | "failed_permanent" | "cancelled";

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

interface TestRow
  extends Omit<Mutable<OutboxClaim>, "claimedBy" | "claimToken" | "claimExpiresAt"> {
  state: State;
  nextAttemptAt: number;
  claimedBy?: string;
  claimToken?: string;
  claimExpiresAt?: Date;
  resultRef?: string;
  lastError?: string;
}

class MemoryOutboxRepository implements OutboxRepository {
  public now = 1_000_000;
  public readonly rows: TestRow[] = [];
  public readonly incidents: string[] = [];
  #token = 0;

  public enqueue(overrides: Partial<TestRow> = {}): TestRow {
    const row: TestRow = {
      id: `0197f000-0000-7000-8000-${String(this.rows.length + 1).padStart(12, "0")}`,
      tenantId: "0197f000-0000-7000-8000-000000000099",
      eventType: "test.delivery",
      payloadVersion: 1,
      payload: { ok: true },
      idempotencyKey: `delivery-${String(this.rows.length + 1)}`,
      attemptCount: 0,
      maxAttempts: 3,
      state: "pending",
      nextAttemptAt: this.now,
      ...overrides
    };
    this.rows.push(row);
    return row;
  }

  public claim(
    workerId: string,
    batchSize = 10,
    leaseSeconds = 60
  ): Promise<readonly OutboxClaim[]> {
    const eligible = this.rows
      .filter(
        (row) =>
          (row.state === "pending" &&
            row.nextAttemptAt <= this.now &&
            row.attemptCount < row.maxAttempts) ||
          (row.state === "processing" && (row.claimExpiresAt?.getTime() ?? Infinity) <= this.now)
      )
      .slice(0, batchSize);
    return Promise.resolve(
      eligible.map((row) => {
        row.state = "processing";
        row.attemptCount = Math.min(row.attemptCount + 1, row.maxAttempts);
        row.claimedBy = workerId;
        row.claimToken = `00000000-0000-4000-8000-${String(++this.#token).padStart(12, "0")}`;
        row.claimExpiresAt = new Date(this.now + leaseSeconds * 1_000);
        return this.asClaim(row);
      })
    );
  }

  public markSent(claim: OutboxClaim, resultRef: string): Promise<boolean> {
    const row = this.current(claim);
    if (row === undefined) return Promise.resolve(false);
    row.state = "sent";
    row.resultRef = resultRef;
    this.clearClaim(row);
    return Promise.resolve(true);
  }

  public markFailed(claim: OutboxClaim, failure: OutboxFailure): Promise<boolean> {
    const row = this.current(claim);
    if (row === undefined) return Promise.resolve(false);
    row.lastError = failure.errorCode;
    const terminal = failure.permanent || row.attemptCount >= row.maxAttempts;
    row.state = terminal ? "failed_permanent" : "pending";
    row.nextAttemptAt = this.now + failure.retryDelaySeconds * 1_000;
    if (terminal) this.incidents.push(row.id);
    this.clearClaim(row);
    return Promise.resolve(true);
  }

  private asClaim(row: TestRow): OutboxClaim {
    if (
      row.claimedBy === undefined ||
      row.claimToken === undefined ||
      row.claimExpiresAt === undefined
    ) {
      throw new Error("row is not claimed");
    }
    return {
      ...row,
      claimedBy: row.claimedBy,
      claimToken: row.claimToken,
      claimExpiresAt: row.claimExpiresAt
    };
  }

  private current(claim: OutboxClaim): TestRow | undefined {
    return this.rows.find(
      (row) =>
        row.id === claim.id &&
        row.tenantId === claim.tenantId &&
        row.state === "processing" &&
        row.claimedBy === claim.claimedBy &&
        row.claimToken === claim.claimToken &&
        (row.claimExpiresAt?.getTime() ?? 0) > this.now
    );
  }

  private clearClaim(row: TestRow): void {
    delete row.claimedBy;
    delete row.claimToken;
    delete row.claimExpiresAt;
  }
}

function createFixture(repository: MemoryOutboxRepository) {
  const transport = new IdempotentFixtureTransport();
  const worker = new OutboxDrainWorker(repository, [fixtureHandler("test.delivery", 1, transport)]);
  return { transport, worker };
}

describe("durable outbox drain", () => {
  it("retries transient failures and then records success", async () => {
    const repository = new MemoryOutboxRepository();
    const row = repository.enqueue();
    const { transport, worker } = createFixture(repository);
    transport.script(row.tenantId, row.idempotencyKey, ["transient_failure", "success"]);

    expect(await worker.drain({ workerId: "worker-a" })).toMatchObject({ retried: 1 });
    expect(row.state).toBe("pending");
    repository.now = row.nextAttemptAt;
    expect(await worker.drain({ workerId: "worker-a" })).toMatchObject({ sent: 1 });
    expect(row.state).toBe("sent");
  });

  it("creates a terminal incident for a permanent failure", async () => {
    const repository = new MemoryOutboxRepository();
    const row = repository.enqueue();
    const { transport, worker } = createFixture(repository);
    transport.script(row.tenantId, row.idempotencyKey, ["permanent_failure"]);

    expect(await worker.drain({ workerId: "worker-a" })).toMatchObject({ failedPermanent: 1 });
    expect(row.state).toBe("failed_permanent");
    expect(repository.incidents).toEqual([row.id]);
  });

  it("terminates after the configured maximum attempt", async () => {
    const repository = new MemoryOutboxRepository();
    const row = repository.enqueue({ maxAttempts: 2 });
    const { transport, worker } = createFixture(repository);
    transport.script(row.tenantId, row.idempotencyKey, ["transient_failure", "transient_failure"]);

    await worker.drain({ workerId: "worker-a" });
    repository.now = row.nextAttemptAt;
    expect(await worker.drain({ workerId: "worker-a" })).toMatchObject({ failedPermanent: 1 });
    expect(row.state).toBe("failed_permanent");
  });

  it("reclaims a crashed delivery without duplicating its external effect", async () => {
    const repository = new MemoryOutboxRepository();
    const row = repository.enqueue({ maxAttempts: 1 });
    const { transport, worker } = createFixture(repository);

    await expect(
      worker.drain({
        workerId: "worker-a",
        leaseSeconds: 5,
        afterExternalEffect: () => {
          throw new SimulatedWorkerCrash();
        }
      })
    ).rejects.toBeInstanceOf(SimulatedWorkerCrash);
    expect(row.state).toBe("processing");
    repository.now += 5_001;
    expect(await worker.drain({ workerId: "worker-b" })).toMatchObject({ sent: 1 });
    expect(transport.effectCount(row.tenantId, row.idempotencyKey)).toBe(1);
    expect(transport.callCount(row.tenantId, row.idempotencyKey)).toBe(2);
  });

  it("prevents concurrent claimers from receiving the same row", async () => {
    const repository = new MemoryOutboxRepository();
    repository.enqueue();
    const [first, second] = await Promise.all([
      repository.claim("worker-a", 1),
      repository.claim("worker-b", 1)
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("rejects a stale acknowledgement after another worker reclaims the lease", async () => {
    const repository = new MemoryOutboxRepository();
    repository.enqueue();
    const [stale] = await repository.claim("worker-a", 1, 5);
    repository.now += 5_001;
    const [current] = await repository.claim("worker-b", 1, 5);
    if (stale === undefined || current === undefined) throw new Error("expected both claims");
    expect(await repository.markSent(stale, "stale")).toBe(false);
    expect(await repository.markSent(current, "current")).toBe(true);
  });

  it("does not claim cancelled rows", async () => {
    const repository = new MemoryOutboxRepository();
    repository.enqueue({ state: "cancelled" });
    expect(await repository.claim("worker-a")).toEqual([]);
  });

  it("fails unknown event versions permanently without making an external call", async () => {
    const repository = new MemoryOutboxRepository();
    const row = repository.enqueue({ payloadVersion: 2 });
    const { transport, worker } = createFixture(repository);
    expect(await worker.drain({ workerId: "worker-a" })).toMatchObject({ failedPermanent: 1 });
    expect(row.state).toBe("failed_permanent");
    expect(transport.callCount(row.tenantId, row.idempotencyKey)).toBe(0);
  });

  it("uses deterministic capped backoff jitter", () => {
    expect(retryDelaySeconds("same-key", 4)).toBe(retryDelaySeconds("same-key", 4));
    expect(retryDelaySeconds("same-key", 50)).toBeLessThanOrEqual(3_600);
    expect(() => retryDelaySeconds("key", 0)).toThrow("positive integer");
  });

  it("namespaces identical idempotency keys by tenant", async () => {
    const repository = new MemoryOutboxRepository();
    const sharedKey = "shared-key";
    const first = repository.enqueue({ idempotencyKey: sharedKey });
    const second = repository.enqueue({
      tenantId: "0197f000-0000-7000-8000-000000000100",
      idempotencyKey: sharedKey
    });
    const { transport, worker } = createFixture(repository);
    await expect(worker.drain({ workerId: "worker-a", batchSize: 2 })).resolves.toMatchObject({
      sent: 2
    });
    expect(transport.effectCount(first.tenantId, sharedKey)).toBe(1);
    expect(transport.effectCount(second.tenantId, sharedKey)).toBe(1);
    expect(first.resultRef).not.toBe(second.resultRef);
  });
});
