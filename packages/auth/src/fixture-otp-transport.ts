import type { EmailOtpPurpose, OtpTransport } from "./otp-transport.js";

export type FixtureOtpDelivery = Readonly<{
  channel: "email" | "phone";
  recipient: string;
  code: string;
  purpose?: EmailOtpPurpose;
}>;

/** In-memory delivery sink for local/test use. It performs no I/O and never logs PII. */
export class FixtureOtpTransport implements OtpTransport {
  readonly #deliveries: FixtureOtpDelivery[] = [];

  sendPhoneOtp(phoneNumber: string, code: string): Promise<void> {
    this.#deliveries.push({ channel: "phone", recipient: phoneNumber, code });
    return Promise.resolve();
  }

  sendEmailOtp(email: string, code: string, purpose: EmailOtpPurpose): Promise<void> {
    this.#deliveries.push({ channel: "email", recipient: email, code, purpose });
    return Promise.resolve();
  }

  latest(
    channel: FixtureOtpDelivery["channel"],
    recipient: string
  ): FixtureOtpDelivery | undefined {
    return this.#deliveries.findLast(
      (delivery) => delivery.channel === channel && delivery.recipient === recipient
    );
  }

  clear(): void {
    this.#deliveries.length = 0;
  }
}
