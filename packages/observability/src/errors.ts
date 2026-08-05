import { sanitizeTelemetry } from "./redaction.js";
import { sanitizeTelemetryContext, type TelemetryContext } from "./logger.js";

export interface SentryCompatibleClient {
  readonly captureException: (
    error: unknown,
    context?: { readonly extra?: Readonly<Record<string, unknown>> }
  ) => string;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  readonly capture: (
    error: unknown,
    context: TelemetryContext,
    extra?: Readonly<Record<string, unknown>>
  ) => string | undefined;
}

/**
 * Sentry reporting is explicitly gated by DSN. Local, CI and fixture execution
 * are guaranteed no-op when a DSN is absent.
 */
export function createErrorReporter(
  dsn: string | undefined,
  client: SentryCompatibleClient | undefined
): ErrorReporter {
  if (dsn === undefined || dsn.trim().length === 0) {
    return { enabled: false, capture: () => undefined };
  }
  if (client === undefined) throw new Error("A Sentry client is required when SENTRY_DSN is set");

  return {
    enabled: true,
    capture: (error, context, eventExtra = {}) => {
      const sanitizedError = sanitizeTelemetry(error);
      const errorFields =
        sanitizedError !== null &&
        typeof sanitizedError === "object" &&
        !Array.isArray(sanitizedError)
          ? (sanitizedError as Readonly<Record<string, unknown>>)
          : {};
      const safeError = new Error(
        typeof errorFields.message === "string" ? errorFields.message : "Captured error"
      );
      safeError.name = typeof errorFields.name === "string" ? errorFields.name : "Error";
      if (typeof errorFields.stack === "string") safeError.stack = errorFields.stack;
      const sanitized = sanitizeTelemetry({
        ...sanitizeTelemetryContext(context),
        attributes: eventExtra
      });
      const extra =
        sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
          ? (sanitized as Readonly<Record<string, unknown>>)
          : {};
      return client.captureException(safeError, { extra });
    }
  };
}
