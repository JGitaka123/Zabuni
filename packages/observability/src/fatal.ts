import type { ErrorReporter } from "./errors.js";
import type { StructuredLogger } from "./logger.js";

/**
 * Process-level crash reporting.
 *
 * Node terminates on an uncaught exception or unhandled rejection and writes a
 * raw stack to stderr. That output reaches neither Sentry nor the structured log
 * stream, so a crash looks identical to a clean exit in the tenant-visible
 * telemetry -- exactly the swallowed failure invariant 4 forbids.
 *
 * Handlers report first and exit second, and never throw: a crash raised while
 * reporting a crash must not mask the original error.
 */

/** Minimal surface of `process` these handlers need, so tests can supply a stub. */
export interface FatalProcessLike {
  readonly on: (event: string, listener: (value: unknown) => void) => unknown;
  readonly off: (event: string, listener: (value: unknown) => void) => unknown;
}

export interface FatalHandlerOptions {
  readonly logger: StructuredLogger;
  readonly errors: ErrorReporter;
  /** Correlation id for the crash records; usually the service or worker id. */
  readonly correlationId: string;
  /** Best-effort cleanup (close pools, stop loops) before the process dies. */
  readonly onFatal?: (reason: FatalReason) => void;
  readonly exit?: (code: number) => void;
  readonly target?: FatalProcessLike;
}

export type FatalReason = "uncaught_exception" | "unhandled_rejection";

const EVENT_BY_REASON: Readonly<Record<FatalReason, string>> = {
  uncaught_exception: "process_uncaught_exception",
  unhandled_rejection: "process_unhandled_rejection"
};

/**
 * Installs crash handlers and returns a disposer.
 *
 * The first fatal wins: later ones are ignored so a cascade cannot loop.
 */
export function installFatalHandlers(options: FatalHandlerOptions): () => void {
  // Node types `process.on` as a set of per-event overloads that will not unify
  // with this general shape, so the default target is a thin adapter rather than
  // `process` itself.
  const target: FatalProcessLike = options.target ?? {
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener)
  };
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let handled = false;

  const report = (reason: FatalReason, error: unknown): void => {
    if (handled) return;
    handled = true;

    // Each step is isolated: a failure in reporting must not prevent the exit,
    // and must not replace the original error with a reporting error.
    try {
      options.errors.capture(error, { correlationId: options.correlationId });
    } catch {
      /* reporting is best effort */
    }
    try {
      options.logger.error(
        EVENT_BY_REASON[reason],
        { correlationId: options.correlationId },
        // Only the error name: messages and stacks can carry PII such as phone
        // numbers or message bodies. The full error goes to Sentry, which redacts.
        { reason, error: error instanceof Error ? error.name : "unknown" }
      );
    } catch {
      /* logging is best effort */
    }
    try {
      options.onFatal?.(reason);
    } catch {
      /* cleanup is best effort */
    }

    exit(1);
  };

  const onUncaught = (error: unknown): void => {
    report("uncaught_exception", error);
  };
  const onRejection = (error: unknown): void => {
    report("unhandled_rejection", error);
  };

  target.on("uncaughtException", onUncaught);
  target.on("unhandledRejection", onRejection);

  return () => {
    target.off("uncaughtException", onUncaught);
    target.off("unhandledRejection", onRejection);
  };
}
