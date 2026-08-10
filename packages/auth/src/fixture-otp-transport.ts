import type { EmailOtpPurpose, OtpTransport } from "./otp-transport.js";

export type FixtureOtpDelivery = Readonly<{
  recipient: string;
  code: string;
  purpose: EmailOtpPurpose;
}>;

/**
 * Observer for fixture deliveries.
 *
 * Codes are stored hashed, so there is no way to recover one from the database.
 * A local tester therefore needs some channel to read the code back. The API
 * wires this to a file mailbox in fixture mode only; production refuses to boot
 * in fixture mode at all, so this can never be reachable there.
 */
export type FixtureOtpSink = (delivery: FixtureOtpDelivery) => void;

/** In-memory delivery sink for local/test use. It performs no network I/O. */
export class FixtureOtpTransport implements OtpTransport {
  readonly #deliveries: FixtureOtpDelivery[] = [];
  readonly #sink: FixtureOtpSink | undefined;

  constructor(sink?: FixtureOtpSink) {
    this.#sink = sink;
  }

  sendEmailOtp(email: string, code: string, purpose: EmailOtpPurpose): Promise<void> {
    const delivery: FixtureOtpDelivery = { recipient: email, code, purpose };
    this.#deliveries.push(delivery);
    // A failing local mailbox must not break sign-in during testing.
    try {
      this.#sink?.(delivery);
    } catch {
      /* the in-memory record above remains authoritative */
    }
    return Promise.resolve();
  }

  latest(recipient: string): FixtureOtpDelivery | undefined {
    return this.#deliveries.findLast((delivery) => delivery.recipient === recipient);
  }

  clear(): void {
    this.#deliveries.length = 0;
  }
}
