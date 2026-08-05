import { sanitizeTelemetry } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PinoCompatibleLogger {
  readonly debug: (bindings: object, message?: string) => void;
  readonly info: (bindings: object, message?: string) => void;
  readonly warn: (bindings: object, message?: string) => void;
  readonly error: (bindings: object, message?: string) => void;
}

export interface StructuredLogger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
}

export interface TelemetryContext {
  readonly correlationId: string;
  readonly requestId?: string;
  readonly jobId?: string;
  readonly tenantId?: string;
}

type LogMethod = (
  event: string,
  context: TelemetryContext,
  attributes?: Readonly<Record<string, unknown>>
) => void;

export interface LoggerOptions {
  readonly service: string;
  readonly environment: string;
}

function requiredLabel(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be blank`);
  if (normalized.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(`${name} must be a telemetry-safe label`);
  }
  if (sanitizeTelemetry(normalized) !== normalized) {
    throw new Error(`${name} must be a telemetry-safe label`);
  }
  return normalized;
}

export function sanitizeTelemetryContext(context: TelemetryContext): TelemetryContext {
  return {
    correlationId: requiredLabel(context.correlationId, "correlationId"),
    ...(context.requestId === undefined
      ? {}
      : { requestId: requiredLabel(context.requestId, "requestId") }),
    ...(context.jobId === undefined ? {} : { jobId: requiredLabel(context.jobId, "jobId") }),
    ...(context.tenantId === undefined
      ? {}
      : { tenantId: requiredLabel(context.tenantId, "tenantId") })
  };
}

/** A deliberately small Pino facade: callers cannot bypass telemetry redaction. */
export function createStructuredLogger(
  sink: PinoCompatibleLogger,
  options: LoggerOptions
): StructuredLogger {
  const service = requiredLabel(options.service, "service");
  const environment = requiredLabel(options.environment, "environment");

  const write = (
    level: LogLevel,
    event: string,
    context: TelemetryContext,
    attributes: Readonly<Record<string, unknown>> = {}
  ): void => {
    const eventName = requiredLabel(event, "event");
    const safeContext = sanitizeTelemetryContext(context);
    const safe = sanitizeTelemetry(attributes);
    sink[level](
      { service, environment, event: eventName, ...safeContext, attributes: safe },
      eventName
    );
  };

  return {
    debug: (event, context, attributes) => {
      write("debug", event, context, attributes);
    },
    info: (event, context, attributes) => {
      write("info", event, context, attributes);
    },
    warn: (event, context, attributes) => {
      write("warn", event, context, attributes);
    },
    error: (event, context, attributes) => {
      write("error", event, context, attributes);
    }
  };
}
