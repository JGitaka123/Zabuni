import pino, { type DestinationStream } from "pino";

import { createStructuredLogger, type StructuredLogger } from "./logger.js";

export interface PinoLoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly destination?: DestinationStream;
}

/** Creates the production JSON logger; deployment owns stdout shipping to Betterstack. */
export function createPinoStructuredLogger(options: PinoLoggerOptions): StructuredLogger {
  const sink = pino(
    {
      base: null,
      level: options.level ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime
    },
    options.destination
  );
  return createStructuredLogger(sink, options);
}
