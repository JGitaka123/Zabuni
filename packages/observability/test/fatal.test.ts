import { describe, expect, it } from "vitest";

import type { ErrorReporter } from "../src/errors.js";
import { installFatalHandlers, type FatalProcessLike } from "../src/fatal.js";
import type { StructuredLogger } from "../src/logger.js";

interface Recorded {
  readonly event: string;
  readonly attributes: Readonly<Record<string, unknown>> | undefined;
}

/** Stands in for `process`, so a test never installs real crash handlers. */
class StubProcess implements FatalProcessLike {
  readonly #listeners = new Map<string, ((value: unknown) => void)[]>();

  public on(event: string, listener: (value: unknown) => void): this {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  public off(event: string, listener: (value: unknown) => void): this {
    const existing = (this.#listeners.get(event) ?? []).filter((entry) => entry !== listener);
    this.#listeners.set(event, existing);
    return this;
  }

  public listenerCount(event: string): number {
    return (this.#listeners.get(event) ?? []).length;
  }

  public emit(event: string, value: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      listener(value);
    }
  }
}

function createHarness(overrides: { readonly failingReporter?: boolean } = {}) {
  const logged: Recorded[] = [];
  const captured: unknown[] = [];
  const exits: number[] = [];
  const cleanups: string[] = [];

  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (event: string, _context: unknown, attributes?: Readonly<Record<string, unknown>>) => {
      logged.push({ event, attributes });
    }
  } as unknown as StructuredLogger;

  const errors: ErrorReporter = {
    enabled: true,
    capture: (error: unknown) => {
      if (overrides.failingReporter === true) throw new Error("sentry transport down");
      captured.push(error);
      return undefined;
    }
  };

  const target = new StubProcess();
  const dispose = installFatalHandlers({
    logger,
    errors,
    correlationId: "api",
    target,
    exit: (code) => exits.push(code),
    onFatal: (reason) => cleanups.push(reason)
  });

  return { logged, captured, exits, cleanups, target, dispose };
}

describe("installFatalHandlers", () => {
  it("reports and exits on an uncaught exception", () => {
    const harness = createHarness();
    const failure = new TypeError("boom");

    harness.target.emit("uncaughtException", failure);

    expect(harness.captured).toEqual([failure]);
    expect(harness.logged[0]?.event).toBe("process_uncaught_exception");
    expect(harness.logged[0]?.attributes?.reason).toBe("uncaught_exception");
    expect(harness.exits).toEqual([1]);
  });

  it("reports and exits on an unhandled rejection", () => {
    const harness = createHarness();

    harness.target.emit("unhandledRejection", new Error("nope"));

    expect(harness.logged[0]?.event).toBe("process_unhandled_rejection");
    expect(harness.exits).toEqual([1]);
  });

  it("runs cleanup before exiting", () => {
    const harness = createHarness();

    harness.target.emit("uncaughtException", new Error("boom"));

    expect(harness.cleanups).toEqual(["uncaught_exception"]);
  });

  it("handles only the first fatal so a cascade cannot loop", () => {
    const harness = createHarness();

    harness.target.emit("uncaughtException", new Error("first"));
    harness.target.emit("unhandledRejection", new Error("second"));
    harness.target.emit("uncaughtException", new Error("third"));

    expect(harness.logged).toHaveLength(1);
    expect(harness.exits).toEqual([1]);
  });

  it("still exits when the error reporter itself throws", () => {
    // A crash raised while reporting a crash must not mask the original one.
    const harness = createHarness({ failingReporter: true });

    harness.target.emit("uncaughtException", new Error("boom"));

    expect(harness.logged[0]?.event).toBe("process_uncaught_exception");
    expect(harness.exits).toEqual([1]);
  });

  it("logs the error name only, never its message", () => {
    const harness = createHarness();
    // Messages and stacks can carry a phone number or message body.
    harness.target.emit("uncaughtException", new Error("failed for +254712345678"));

    expect(JSON.stringify(harness.logged)).not.toContain("+254712345678");
    expect(harness.logged[0]?.attributes?.error).toBe("Error");
  });

  it("removes its listeners when disposed", () => {
    const harness = createHarness();
    expect(harness.target.listenerCount("uncaughtException")).toBe(1);

    harness.dispose();

    expect(harness.target.listenerCount("uncaughtException")).toBe(0);
    expect(harness.target.listenerCount("unhandledRejection")).toBe(0);
  });
});
