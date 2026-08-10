export type EmailOtpPurpose = "sign-in" | "email-verification" | "forget-password";

/**
 * Auth OTP delivery. Email only.
 *
 * Phone sign-in was removed: Better Auth's phone plugin stores the active code
 * in the verification row and compares it as a plain string, with no
 * hash-at-rest option in any release. Anyone able to read that table could
 * complete a sign-in inside the code's validity window. The email plugin
 * supports `storeOTP: "hashed"`, so email is the auditable channel.
 */
export interface OtpTransport {
  readonly sendEmailOtp: (email: string, code: string, purpose: EmailOtpPurpose) => Promise<void>;
}

export class UnconfiguredOtpTransport implements OtpTransport {
  sendEmailOtp(email: string, code: string, purpose: EmailOtpPurpose): Promise<never> {
    void email;
    void code;
    void purpose;
    return Promise.reject(new Error("Live email OTP delivery is not configured"));
  }
}
