import {
  createPinoStructuredLogger,
  initializeNodeSentry,
  type ErrorReporter,
  type StructuredLogger
} from "@zabuni/observability";
import type { IntegrationMode } from "@zabuni/core";

export interface WorkerObservability {
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
}

export function createWorkerObservability(
  environment: string,
  integrationMode: IntegrationMode,
  sentryDsn?: string
): WorkerObservability {
  return {
    logger: createPinoStructuredLogger({ service: "worker", environment }),
    errors: initializeNodeSentry({
      environment,
      integrationMode,
      ...(sentryDsn === undefined ? {} : { dsn: sentryDsn })
    })
  };
}
