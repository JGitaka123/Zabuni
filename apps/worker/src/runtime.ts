import { createOutboxWorkerStore, type OutboxWorkerStore } from "@zabuni/db/privileged/outbox";

import { OutboxDrainWorker, type OutboxHandler, type WorkerTelemetry } from "./outbox.js";

export interface DatabaseDrainRuntime {
  readonly worker: OutboxDrainWorker;
  readonly store: OutboxWorkerStore;
  readonly close: () => Promise<void>;
}

export function createDatabaseDrainRuntime(
  workerDatabaseUrl: string,
  handlers: readonly OutboxHandler[],
  telemetry?: WorkerTelemetry
): DatabaseDrainRuntime {
  const repository = createOutboxWorkerStore(workerDatabaseUrl);
  return {
    worker: new OutboxDrainWorker(repository, handlers, telemetry),
    store: repository,
    close: repository.close
  };
}
