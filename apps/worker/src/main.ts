import { loadWorkerConfig } from "@zabuni/core";

import { OutboxDrainLoop, waitForDatabase } from "./loop.js";
import { createWorkerObservability } from "./observability.js";
import type { OutboxHandler } from "./outbox.js";
import { createDatabaseDrainRuntime } from "./runtime.js";

/**
 * Delivery handlers registered with the drain.
 *
 * Deliberately empty: the first real producer is eTIMS transmission (E-3), which
 * is Phase 2 work. This must stay empty until a handler actually exists, and the
 * bootstrap below refuses to run without one -- see the guard for why.
 */
const handlers: readonly OutboxHandler[] = [];

export async function main(): Promise<number> {
  const config = loadWorkerConfig();
  const telemetry = createWorkerObservability(
    config.environment,
    config.sentryDsn,
    config.integrationMode
  );
  const context = { correlationId: config.workerId };

  if (handlers.length === 0) {
    // The drain marks any claim with no registered handler as a permanent
    // failure and opens a tenant incident. Booting an empty worker against a
    // queue with real rows would therefore destroy every queued delivery.
    telemetry.logger.error("worker_no_handlers_registered", context, {
      reason: "no outbox delivery handlers are registered yet"
    });
    return 1;
  }

  const runtime = createDatabaseDrainRuntime(config.workerDatabaseUrl, handlers, telemetry);
  const loop = new OutboxDrainLoop(
    runtime.worker,
    runtime.store,
    {
      workerId: config.workerId,
      pollIntervalMs: config.pollIntervalMs,
      idlePollIntervalMs: config.idlePollIntervalMs,
      leaseSeconds: config.leaseSeconds
    },
    telemetry
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    telemetry.logger.info("worker_shutdown_requested", context, { signal });
    // Stop is cooperative; the grace timer is the backstop if a delivery hangs.
    const forceExit = setTimeout(() => {
      telemetry.logger.error("worker_shutdown_timed_out", context, {
        graceMs: config.shutdownGraceMs
      });
      process.exit(1);
    }, config.shutdownGraceMs);
    forceExit.unref();
    void loop.stop();
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  try {
    await waitForDatabase(runtime.store);
    telemetry.logger.info("worker_started", context, {
      environment: config.environment,
      integrationMode: config.integrationMode,
      pollIntervalMs: config.pollIntervalMs
    });
    const totals = await loop.start();
    telemetry.logger.info("worker_stopped", context, {
      iterations: totals.iterations,
      sent: totals.sent,
      retried: totals.retried,
      failedPermanent: totals.failedPermanent,
      drainErrors: totals.drainErrors
    });
    return 0;
  } catch (error) {
    telemetry.errors.capture(error, context);
    telemetry.logger.error("worker_failed", context, {
      error: error instanceof Error ? error.name : "unknown"
    });
    return 1;
  } finally {
    await runtime.close();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Configuration failures happen before telemetry exists, so this is the
      // only place a raw write to stderr is correct.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
