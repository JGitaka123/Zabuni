import { redactText } from "@zabuni/core";

export const REDACTED_VALUE = "[REDACTED]";
export const CIRCULAR_VALUE = "[Circular]";
export const TRUNCATED_VALUE = "[Truncated]";
export const UNSERIALIZABLE_VALUE = "[Unserializable]";

export interface RedactionLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxStringLength: number;
}

const DEFAULT_LIMITS: RedactionLimits = {
  maxDepth: 8,
  maxEntries: 100,
  maxStringLength: 4_096
};

const SENSITIVE_KEYS = new Set([
  "phone",
  "phonenumber",
  "mobile",
  "mobilenumber",
  "msisdn",
  "krapin",
  "taxpin",
  "otp",
  "otpcode",
  "password",
  "secret",
  "authorization",
  "cookie",
  "token",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret",
  "email",
  "useremail",
  "billingemail",
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
  "text"
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return SENSITIVE_KEYS.has(normalized) || normalized.endsWith("password");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolvedLimits(overrides: Partial<RedactionLimits>): RedactionLimits {
  return {
    maxDepth: positiveInteger(overrides.maxDepth ?? DEFAULT_LIMITS.maxDepth, "maxDepth"),
    maxEntries: positiveInteger(overrides.maxEntries ?? DEFAULT_LIMITS.maxEntries, "maxEntries"),
    maxStringLength: positiveInteger(
      overrides.maxStringLength ?? DEFAULT_LIMITS.maxStringLength,
      "maxStringLength"
    )
  };
}

function safeString(value: string, maxLength: number): string {
  const bounded =
    value.length <= maxLength ? value : `${value.slice(0, maxLength)}${TRUNCATED_VALUE}`;
  return redactText(bounded);
}

/**
 * Produces a JSON-safe, bounded copy for every external telemetry boundary.
 * Circular references never escape and hostile payloads cannot cause unbounded
 * traversal or oversized log/error events.
 */
export function sanitizeTelemetry(
  value: unknown,
  limitOverrides: Partial<RedactionLimits> = {}
): unknown {
  const limits = resolvedLimits(limitOverrides);
  const ancestors = new WeakSet<object>();
  let remainingEntries = limits.maxEntries;

  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return safeString(current, limits.maxStringLength);
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? UNSERIALIZABLE_VALUE : current.toISOString();
    }
    if (current instanceof Error) {
      return {
        name: safeString(current.name, limits.maxStringLength),
        message: safeString(current.message, limits.maxStringLength),
        ...(current.stack === undefined
          ? {}
          : { stack: safeString(current.stack, limits.maxStringLength) })
      };
    }
    if (typeof current === "undefined") return "undefined";
    if (typeof current === "symbol") {
      return safeString(current.description ?? "symbol", limits.maxStringLength);
    }
    if (typeof current === "function") {
      return `[Function ${safeString(current.name || "anonymous", limits.maxStringLength)}]`;
    }
    if (depth >= limits.maxDepth) return TRUNCATED_VALUE;
    if (ancestors.has(current)) return CIRCULAR_VALUE;

    ancestors.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      const output: unknown[] = [];
      let index = 0;
      while (index < current.length && remainingEntries > 0) {
        remainingEntries -= 1;
        output.push(visit(current[index], depth + 1));
        index += 1;
      }
      if (index < current.length) output.push(TRUNCATED_VALUE);
      result = output;
    } else {
      let entries: [string, unknown][];
      try {
        entries = Object.entries(current);
      } catch {
        ancestors.delete(current);
        return UNSERIALIZABLE_VALUE;
      }
      const output: Record<string, unknown> = {};
      let processed = 0;
      for (const [key, entry] of entries) {
        if (remainingEntries === 0) break;
        remainingEntries -= 1;
        const boundedKey = safeString(key, limits.maxStringLength);
        const safeKey = boundedKey === key ? key : `redacted_field_${String(processed)}`;
        output[safeKey] = isSensitiveKey(key) ? REDACTED_VALUE : visit(entry, depth + 1);
        processed += 1;
      }
      if (processed < entries.length) output.__truncated__ = TRUNCATED_VALUE;
      result = output;
    }
    ancestors.delete(current);
    return result;
  };

  return visit(value, 0);
}
