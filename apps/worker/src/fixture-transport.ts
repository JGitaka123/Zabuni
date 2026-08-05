import { PermanentDeliveryError, type OutboxClaim, type OutboxHandler } from "./outbox.js";

export type FixtureOutcome = "success" | "transient_failure" | "permanent_failure";

export class IdempotentFixtureTransport {
  readonly #scripts = new Map<string, FixtureOutcome[]>();
  readonly #effects = new Map<string, string>();
  readonly #calls = new Map<string, number>();

  private key(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}:${idempotencyKey}`;
  }

  public script(
    tenantId: string,
    idempotencyKey: string,
    outcomes: readonly FixtureOutcome[]
  ): void {
    this.#scripts.set(this.key(tenantId, idempotencyKey), [...outcomes]);
  }

  public effectCount(tenantId: string, idempotencyKey: string): number {
    return this.#effects.has(this.key(tenantId, idempotencyKey)) ? 1 : 0;
  }

  public callCount(tenantId: string, idempotencyKey: string): number {
    return this.#calls.get(this.key(tenantId, idempotencyKey)) ?? 0;
  }

  public send(claim: OutboxClaim): Promise<{ readonly resultRef: string }> {
    const namespace = this.key(claim.tenantId, claim.idempotencyKey);
    this.#calls.set(namespace, this.callCount(claim.tenantId, claim.idempotencyKey) + 1);
    const existing = this.#effects.get(namespace);
    if (existing !== undefined) return Promise.resolve({ resultRef: existing });

    const script = this.#scripts.get(namespace) ?? ["success"];
    const outcome = script.shift() ?? "success";
    this.#scripts.set(namespace, script);
    if (outcome === "transient_failure") throw new Error("fixture dependency unavailable");
    if (outcome === "permanent_failure") {
      throw new PermanentDeliveryError("fixture request rejected");
    }

    const resultRef = `fixture:${claim.tenantId}:${claim.idempotencyKey}`;
    this.#effects.set(namespace, resultRef);
    return Promise.resolve({ resultRef });
  }
}

export function fixtureHandler(
  eventType: string,
  payloadVersion: number,
  transport: IdempotentFixtureTransport
): OutboxHandler {
  return {
    eventType,
    payloadVersion,
    send: (claim) => transport.send(claim)
  };
}
