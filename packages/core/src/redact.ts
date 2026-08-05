export const REDACTED_PHONE = "[REDACTED_PHONE]";
export const REDACTED_KRA_PIN = "[REDACTED_KRA_PIN]";
export const REDACTED_OTP = "[REDACTED_OTP]";
export const REDACTED_MESSAGE = "[REDACTED_MESSAGE]";

const KRA_PIN_PATTERN = /\b[A-Z]\d{9}[A-Z]\b/gi;
const KENYAN_PHONE_PATTERN =
  /(?<!\d)(?:\+?254|0)(?:[\s().-]?\d){8,9}(?!\d)/g;
const CONTEXTUAL_OTP_PATTERN =
  /\b((?:one[- ]time (?:password|pin)|otp|verification code|security code|auth(?:entication)? code)\s*(?:is|:|=|-)?\s*)\d{4,8}\b/gi;

const PHONE_KEYS = new Set([
  "phone",
  "phonenumber",
  "mobile",
  "mobilenumber",
  "msisdn",
  "contactphone",
  "customerphone",
  "recipientphone",
  "senderphone",
]);
const KRA_PIN_KEYS = new Set(["krapin", "taxpin"]);
const OTP_KEYS = new Set([
  "otp",
  "otpcode",
  "onetimepassword",
  "verificationcode",
  "securitycode",
]);
const MESSAGE_KEYS = new Set([
  "message",
  "messagebody",
  "messagetext",
  "smsbody",
  "whatsappmessage",
  "emailbody",
  "body",
  "content",
  "rawbody",
  "requestbody",
  "responsebody",
  "text",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function redactText(value: string): string {
  return value
    .replaceAll(KRA_PIN_PATTERN, REDACTED_KRA_PIN)
    .replaceAll(KENYAN_PHONE_PATTERN, REDACTED_PHONE)
    .replaceAll(
      CONTEXTUAL_OTP_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED_OTP}`,
    );
}

function replacementForKey(key: string): string | undefined {
  const normalized = normalizedKey(key);
  if (PHONE_KEYS.has(normalized)) return REDACTED_PHONE;
  if (KRA_PIN_KEYS.has(normalized)) return REDACTED_KRA_PIN;
  if (OTP_KEYS.has(normalized)) return REDACTED_OTP;
  if (MESSAGE_KEYS.has(normalized)) return REDACTED_MESSAGE;
  return undefined;
}

/**
 * Recursively copies logger data while scrubbing sensitive keys and PII found
 * inside arbitrary string values. Circular references remain circular safely.
 */
export function redactSensitive(value: unknown): unknown {
  const seen = new WeakMap<object, object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactText(current);
    if (current === null || typeof current !== "object") return current;
    if (current instanceof Date) return new Date(current.getTime());

    const existing = seen.get(current);
    if (existing !== undefined) return existing;

    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      seen.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }

    const copy: Record<string, unknown> = {};
    seen.set(current, copy);
    for (const [key, item] of Object.entries(current)) {
      copy[key] = replacementForKey(key) ?? visit(item);
    }
    return copy;
  };

  return visit(value);
}
