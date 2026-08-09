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
  sentryDsn?: string,
  integrationMode: string = process.env.INTEGRATION_MODE ?? "fixture"
): WorkerObservability {
  return {
    logger: createPinoStructuredLogger({ service: "worker", environment }),
    errors: initializeNodeSentry({
      environment,
      integrationMode: integrationMode === "live" ? "live" : "fixture",
      ...(sentryDsn === undefined ? {} : { dsn: sentryDsn })
    })
  };
}
