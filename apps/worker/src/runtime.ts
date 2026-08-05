import { createOutboxWorkerStore } from "@zabuni/db/privileged/outbox";

import { OutboxDrainWorker, type OutboxHandler } from "./outbox.js";

export interface DatabaseDrainRuntime {
  readonly worker: OutboxDrainWorker;
  readonly close: () => Promise<void>;
}

export function createDatabaseDrainRuntime(
  workerDatabaseUrl: string,
  handlers: readonly OutboxHandler[]
): DatabaseDrainRuntime {
  const repository = createOutboxWorkerStore(workerDatabaseUrl);
  return {
    worker: new OutboxDrainWorker(repository, handlers),
    close: repository.close
  };
}
