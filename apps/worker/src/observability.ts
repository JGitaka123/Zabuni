import {
  createPinoStructuredLogger,
  initializeNodeSentry,
  type ErrorReporter,
  type StructuredLogger
} from "@zabuni/observability";

export interface WorkerObservability {
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
}

export function createWorkerObservability(
  environment: string,
  sentryDsn?: string
): WorkerObservability {
  return {
    logger: createPinoStructuredLogger({ service: "worker", environment }),
    errors: initializeNodeSentry({
      environment,
      integrationMode: process.env.INTEGRATION_MODE === "live" ? "live" : "fixture",
      ...(sentryDsn === undefined ? {} : { dsn: sentryDsn })
    })
  };
}
