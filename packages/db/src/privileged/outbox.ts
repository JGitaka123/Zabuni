import { sql } from "drizzle-orm";
import { validate as isUuid } from "uuid";

import { createDatabase } from "../client.js";
import { createEntityId, isUuidV7 } from "../ids.js";

export interface ClaimedOutboxRow {
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

export interface OutboxWorkerStore {
  readonly claim: (
    workerId: string,
    batchSize?: number,
    leaseSeconds?: number
  ) => Promise<readonly ClaimedOutboxRow[]>;
  readonly markSent: (claim: ClaimedOutboxRow, resultRef: string) => Promise<boolean>;
  readonly markFailed: (claim: ClaimedOutboxRow, failure: OutboxFailure) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

function assertClaim(claim: ClaimedOutboxRow): void {
  if (!isUuidV7(claim.id) || !isUuidV7(claim.tenantId) || !isUuid(claim.claimToken)) {
    throw new Error("Outbox transition requires a valid claim");
  }
}

export function createOutboxWorkerStore(connectionString: string): OutboxWorkerStore {
  const connection = createDatabase(connectionString);

  async function runInTenant<Result>(
    tenantId: string,
    operation: (
      transaction: Parameters<Parameters<typeof connection.db.transaction>[0]>[0]
    ) => Promise<Result>
  ): Promise<Result> {
    if (!isUuidV7(tenantId)) {
      throw new Error("Outbox worker tenant context must be a UUIDv7");
    }
    return connection.db.transaction(async (transaction) => {
      const [setting] = await transaction.execute<{ tenantId: string }>(
        sql`SELECT set_config('app.tenant_id', ${tenantId}, true) AS "tenantId"`
      );
      if (setting?.tenantId !== tenantId) {
        throw new Error("Failed to establish outbox worker tenant context");
      }
      return operation(transaction);
    });
  }

  return {
    close: () => connection.client.end(),
    claim: async (workerId, batchSize = 10, leaseSeconds = 60) => {
      const rows = await connection.db.execute<{
        id: string;
        tenantId: string;
        eventType: string;
        payloadVersion: number;
        payload: Record<string, unknown>;
        idempotencyKey: string;
        attemptCount: number;
        maxAttempts: number;
        claimedBy: string;
        claimToken: string;
        claimExpiresAt: Date;
      }>(sql`
        SELECT id,
               tenant_id AS "tenantId",
               event_type AS "eventType",
               payload_version AS "payloadVersion",
               payload,
               idempotency_key AS "idempotencyKey",
               attempt_count AS "attemptCount",
               max_attempts AS "maxAttempts",
               claimed_by AS "claimedBy",
               claim_token AS "claimToken",
               claim_expires_at AS "claimExpiresAt"
        FROM app.claim_outbox(${workerId}, ${batchSize}, ${leaseSeconds})
      `);
      return rows;
    },
    markSent: async (claim, resultRef) => {
      assertClaim(claim);
      if (resultRef.trim() === "" || resultRef.length > 256) {
        throw new Error("Outbox success requires a result reference of at most 256 characters");
      }
      return runInTenant(claim.tenantId, async (transaction) => {
        const [updated] = await transaction.execute<{ completed: boolean }>(sql`
          SELECT app.complete_outbox(
            ${claim.id}::uuid,
            ${claim.tenantId}::uuid,
            ${claim.claimedBy},
            ${claim.claimToken}::uuid,
            ${resultRef}
          ) AS completed
        `);
        return updated?.completed === true;
      });
    },
    markFailed: async (claim, failure) => {
      assertClaim(claim);
      if (!/^[a-z0-9_]{1,64}$/u.test(failure.errorCode)) {
        throw new Error("Outbox failure requires an allow-listed safe error code");
      }
      if (
        !Number.isInteger(failure.retryDelaySeconds) ||
        failure.retryDelaySeconds < 0 ||
        failure.retryDelaySeconds > 3_600
      ) {
        throw new Error("Retry delay must be an integer between 0 and 3600");
      }
      return runInTenant(claim.tenantId, async (transaction) => {
        const [updated] = await transaction.execute<{ failed: boolean }>(sql`
          SELECT app.fail_outbox(
            ${claim.id}::uuid,
            ${claim.tenantId}::uuid,
            ${claim.claimedBy},
            ${claim.claimToken}::uuid,
            ${createEntityId()}::uuid,
            ${failure.errorCode},
            ${failure.permanent},
            ${failure.retryDelaySeconds}
          ) AS failed
        `);
        return updated?.failed === true;
      });
    }
  };
}
