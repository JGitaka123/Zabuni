import * as Sentry from "@sentry/node";
import { isValidSentryDsn, type IntegrationMode } from "@zabuni/core";

import { createErrorReporter, type ErrorReporter } from "./errors.js";
import { sanitizeTelemetry } from "./redaction.js";

export interface NodeSentryOptions {
  readonly dsn?: string;
  readonly environment: string;
  readonly release?: string;
  readonly integrationMode: IntegrationMode;
}

/** Initializes Sentry only with an explicit DSN; fixture/local defaults stay offline. */
export function initializeNodeSentry(options: NodeSentryOptions): ErrorReporter {
  if (
    options.integrationMode === "fixture" ||
    options.dsn === undefined ||
    options.dsn.trim().length === 0
  ) {
    return createErrorReporter(undefined, undefined);
  }
  if (!isValidSentryDsn(options.dsn)) {
    throw new Error("Sentry DSN configuration is invalid");
  }

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release === undefined ? {} : { release: options.release }),
    sendDefaultPii: false,
    maxValueLength: 4_096,
    normalizeDepth: 8,
    beforeSend: (event) => sanitizeTelemetry(event) as typeof event,
    beforeBreadcrumb: (breadcrumb) => sanitizeTelemetry(breadcrumb) as typeof breadcrumb
  });
  return createErrorReporter(options.dsn, {
    captureException: (error, context) => {
      let eventId = "";
      Sentry.withScope((scope) => {
        if (context?.extra !== undefined) scope.setExtras({ ...context.extra });
        eventId = Sentry.captureException(error);
      });
      return eventId;
    }
  });
}
