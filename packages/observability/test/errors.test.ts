import * as Sentry from "@sentry/node";
import { describe, expect, it, vi } from "vitest";

import { createErrorReporter, type SentryCompatibleClient } from "../src/errors.js";
import { initializeNodeSentry } from "../src/sentry.js";

describe("createErrorReporter", () => {
  it("is a strict no-op without a DSN", () => {
    const captureException = vi.fn<SentryCompatibleClient["captureException"]>(() => "event-id");
    const reporter = createErrorReporter(undefined, { captureException });
    expect(reporter.enabled).toBe(false);
    expect(
      reporter.capture(new Error("offline"), { correlationId: "correlation-1" })
    ).toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("redacts context before handing it to Sentry", () => {
    const captureException = vi.fn<SentryCompatibleClient["captureException"]>(() => "event-id");
    const reporter = createErrorReporter("https://public@example.invalid/1", {
      captureException
    });
    const result = reporter.capture(
      new Error("Call +254712345678 after failure"),
      { correlationId: "correlation-1", requestId: "request-1" },
      { messageBody: "private", harmless: "Call 0712345678" }
    );
    expect(result).toBe("event-id");
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: {
        correlationId: "correlation-1",
        requestId: "request-1",
        attributes: {
          messageBody: "[REDACTED]",
          harmless: "Call [REDACTED_PHONE]"
        }
      }
    });
    const captured = captureException.mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Call [REDACTED_PHONE] after failure");
  });

  it("requires a client only when reporting is enabled", () => {
    expect(() => createErrorReporter("https://dsn.invalid/1", undefined)).toThrow(/Sentry client/);
  });

  it("keeps the real Sentry transport disabled in fixture mode even with a DSN", () => {
    const reporter = initializeNodeSentry({
      dsn: "https://public@example.invalid/1",
      environment: "test",
      integrationMode: "fixture"
    });
    expect(reporter.enabled).toBe(false);
  });

  it.each(["sandbox", "live"] as const)(
    "enables configured error reporting in %s mode",
    (integrationMode) => {
      const reporter = initializeNodeSentry({
        dsn: "https://public@example.invalid/1",
        environment: "test",
        integrationMode
      });
      expect(reporter.enabled).toBe(true);
      expect(Sentry.getClient()?.getDsn()?.projectId).toBe("1");
      expect(Sentry.getClient()?.getTransport()).toBeDefined();
    }
  );

  it("refuses to claim reporting is enabled for an SDK-invalid HTTPS DSN", () => {
    for (const dsn of [
      "https://example.invalid",
      "https://public@example.invalid/1/",
      "https://public-key@example.invalid/1",
      "https://public@example.invalid:99999/1"
    ]) {
      expect(() =>
        initializeNodeSentry({ dsn, environment: "test", integrationMode: "sandbox" })
      ).toThrow("Sentry DSN configuration is invalid");
    }
  });
});
