export type EmailOtpPurpose = "sign-in" | "email-verification" | "forget-password";

export interface OtpTransport {
  readonly sendPhoneOtp: (phoneNumber: string, code: string) => Promise<void>;
  readonly sendEmailOtp: (email: string, code: string, purpose: EmailOtpPurpose) => Promise<void>;
}

export class UnconfiguredOtpTransport implements OtpTransport {
  sendPhoneOtp(): Promise<never> {
    return Promise.reject(new Error("Live SMS OTP delivery is not configured"));
  }

  sendEmailOtp(): Promise<never> {
    return Promise.reject(new Error("Live email OTP delivery is not configured"));
  }
}
