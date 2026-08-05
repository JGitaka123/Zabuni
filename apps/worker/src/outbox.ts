import type { ErrorReporter, StructuredLogger } from "@zabuni/observability";

export interface OutboxClaim {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly payloadVersion: number;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly claimedBy: string;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
}

export interface OutboxFailure {
  readonly errorCode: string;
  readonly permanent: boolean;
  readonly retryDelaySeconds: number;
}

export interface OutboxRepository {
  readonly claim: (
    workerId: string,
    batchSize?: number,
    leaseSeconds?: number
  ) => Promise<readonly OutboxClaim[]>;
  readonly markSent: (claim: OutboxClaim, resultRef: string) => Promise<boolean>;
  readonly markFailed: (claim: OutboxClaim, failure: OutboxFailure) => Promise<boolean>;
}

export interface OutboxHandler {
  readonly eventType: string;
  readonly payloadVersion: number;
  readonly send: (claim: OutboxClaim) => Promise<{ readonly resultRef: string }>;
}

export class PermanentDeliveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

/** Test-only stand-in for a process dying after the remote side effect. */
export class SimulatedWorkerCrash extends Error {
  public constructor() {
    super("simulated worker crash after external effect");
    this.name = "SimulatedWorkerCrash";
  }
}

export interface DrainOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly afterExternalEffect?: (claim: OutboxClaim) => void;
}

export interface DrainResult {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failedPermanent: number;
  readonly stale: number;
}

export interface WorkerTelemetry {
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** 5 seconds doubling to one hour, with stable ±20% key-based jitter. */
export function retryDelaySeconds(idempotencyKey: string, attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("Attempt count must be a positive integer");
  }
  const exponent = Math.min(attemptCount - 1, 10);
  const base = Math.min(3_600, 5 * 2 ** exponent);
  const jitterBasisPoints = (stableHash(idempotencyKey) % 4_001) - 2_000;
  return Math.max(1, Math.min(3_600, Math.round((base * (10_000 + jitterBasisPoints)) / 10_000)));
}

export class OutboxDrainWorker {
  readonly #repository: OutboxRepository;
  readonly #handlers: ReadonlyMap<string, OutboxHandler>;
  readonly #telemetry: WorkerTelemetry | undefined;

  public constructor(
    repository: OutboxRepository,
    handlers: readonly OutboxHandler[],
    telemetry?: WorkerTelemetry
  ) {
    this.#repository = repository;
    this.#telemetry = telemetry;
    const registry = new Map<string, OutboxHandler>();
    for (const handler of handlers) {
      const key = `${handler.eventType}:${String(handler.payloadVersion)}`;
      if (registry.has(key)) {
        throw new Error(`Duplicate outbox handler: ${key}`);
      }
      registry.set(key, handler);
    }
    this.#handlers = registry;
  }

  public async drain(options: DrainOptions): Promise<DrainResult> {
    const batchSize = options.batchSize ?? 1;
    if (batchSize !== 1) {
      throw new Error("Outbox drain batch size must remain 1 until lease renewal is implemented");
    }
    const claims = await this.#repository.claim(options.workerId, batchSize, options.leaseSeconds);
    const result = { claimed: claims.length, sent: 0, retried: 0, failedPermanent: 0, stale: 0 };

    for (const claim of claims) {
      const handler = this.#handlers.get(`${claim.eventType}:${String(claim.payloadVersion)}`);
      if (handler === undefined) {
        const updated = await this.#repository.markFailed(claim, {
          errorCode: "unsupported_contract",
          permanent: true,
          retryDelaySeconds: 0
        });
        if (updated) result.failedPermanent++;
        else result.stale++;
        this.#telemetry?.logger.error(
          "delivery_unsupported",
          { correlationId: claim.claimToken, jobId: claim.id, tenantId: claim.tenantId },
          { eventType: claim.eventType, payloadVersion: claim.payloadVersion }
        );
        continue;
      }

      try {
        const delivery = await handler.send(claim);
        options.afterExternalEffect?.(claim);
        const updated = await this.#repository.markSent(claim, delivery.resultRef);
        if (updated) result.sent++;
        else result.stale++;
        this.#telemetry?.logger.info(
          "delivery_succeeded",
          { correlationId: claim.claimToken, jobId: claim.id, tenantId: claim.tenantId },
          { attemptCount: claim.attemptCount, stale: !updated }
        );
      } catch (error) {
        if (error instanceof SimulatedWorkerCrash) throw error;
        const permanent = error instanceof PermanentDeliveryError;
        const context = {
          correlationId: claim.claimToken,
          jobId: claim.id,
          tenantId: claim.tenantId
        };
        if (!permanent) this.#telemetry?.errors.capture(error, context);
        const updated = await this.#repository.markFailed(claim, {
          errorCode: permanent ? "permanent_rejection" : "transport_unavailable",
          permanent,
          retryDelaySeconds: permanent
            ? 0
            : retryDelaySeconds(claim.idempotencyKey, claim.attemptCount)
        });
        if (!updated) result.stale++;
        else if (permanent || claim.attemptCount >= claim.maxAttempts) result.failedPermanent++;
        else result.retried++;
        const event = permanent ? "delivery_failed_permanent" : "delivery_retry_scheduled";
        this.#telemetry?.logger[permanent ? "error" : "warn"](event, context, {
          attemptCount: claim.attemptCount,
          stale: !updated
        });
      }
    }

    return result;
  }
}
