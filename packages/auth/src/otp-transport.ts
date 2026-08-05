export type EmailOtpPurpose = "sign-in" | "email-verification" | "forget-password";

export interface OtpTransport {
  readonly sendPhoneOtp: (phoneNumber: string, code: string) => Promise<void>;
  readonly sendEmailOtp: (email: string, code: string, purpose: EmailOtpPurpose) => Promise<void>;
}

export class UnconfiguredOtpTransport implements OtpTransport {
  sendPhoneOtp(phoneNumber: string, code: string): Promise<never> {
    void phoneNumber;
    void code;
    return Promise.reject(new Error("Live SMS OTP delivery is not configured"));
  }

  sendEmailOtp(email: string, code: string, purpose: EmailOtpPurpose): Promise<never> {
    void email;
    void code;
    void purpose;
    return Promise.reject(new Error("Live email OTP delivery is not configured"));
  }
}
