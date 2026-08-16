import type { MembershipRuntime, AuthServer } from "@zabuni/auth";
import type { ErrorReporter, StructuredLogger } from "@zabuni/observability";
import type { TenantRuntime } from "@zabuni/db";
import { describe, expect, it, vi } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

/**
 * Telemetry runs after the response is settled, so a throw there escapes past
 * onError and the adapter answers with an empty 500 -- with no log explaining
 * it, because the logger is what failed. Pino on a saturated pipe raises EAGAIN,
 * which turned roughly 2% of concurrent requests into 500s.
 */
function createDependencies(mode: "logger" | "reporter"): AppDependencies {
  const throwing = (): never => {
    throw new Error("EAGAIN: resource temporarily unavailable, write");
  };
  const logger = {
    debug: () => undefined,
    info: mode === "logger" ? throwing : () => undefined,
    warn: () => undefined,
    error: mode === "logger" ? throwing : () => undefined
  } as unknown as StructuredLogger;
  const errors: ErrorReporter = {
    enabled: true,
    capture: mode === "reporter" ? throwing : () => undefined
  };

  const auth = { handler: () => new Response(null, { status: 404 }) } as unknown as AuthServer;
  const memberships = {
    resolve: () => Promise.resolve(null),
    provision: () => Promise.reject(new Error("not used")),
    ping: () => Promise.resolve(),
    close: () => Promise.resolve()
  } satisfies MembershipRuntime;
  const tenants = {
    run: () => Promise.reject(new Error("not used")),
    close: () => Promise.resolve()
  } as unknown as TenantRuntime;

  return {
    auth,
    memberships,
    tenants,
    webOrigin: "http://localhost:3000",
    telemetry: { logger, errors }
  };
}

describe("telemetry never fails a request", () => {
  it("still answers when the request logger throws", async () => {
    const response = await createApp(createDependencies("logger")).request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("still answers an unmatched route when the logger throws", async () => {
    const response = await createApp(createDependencies("logger")).request("/no-such-route");

    // Previously this surfaced as an empty-bodied 500 from the server adapter.
    expect(response.status).toBe(404);
  });

  it("still returns a correlation id when the error reporter throws", async () => {
    const app = createApp(createDependencies("reporter"));
    app.get("/boom", () => {
      throw new Error("handler failure");
    });

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; correlationId: string };
    expect(body.error).toBe("internal_error");
    expect(typeof body.correlationId).toBe("string");
  });

  it("reports an ordinary failure through both telemetry channels", async () => {
    const dependencies = createDependencies("reporter");
    const telemetry = dependencies.telemetry;
    if (telemetry === undefined) throw new Error("test telemetry is required");
    const logError = vi.fn<StructuredLogger["error"]>();
    const capture = vi.fn<ErrorReporter["capture"]>();
    const app = createApp({
      ...dependencies,
      telemetry: {
        logger: { ...telemetry.logger, error: logError },
        errors: { enabled: true, capture }
      }
    });
    const failure = new Error("ordinary handler failure");
    app.get("/boom", () => {
      throw failure;
    });

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    const logged = logError.mock.calls[0];
    const captured = capture.mock.calls[0];
    expect(logged?.[0]).toBe("request_failed");
    expect(logged?.[1].correlationId).toEqual(expect.stringMatching(/^[0-9a-f-]+$/u));
    expect(logged?.[2]).toEqual({ error: failure });
    expect(captured?.[0]).toBe(failure);
    expect(captured?.[1].correlationId).toEqual(expect.stringMatching(/^[0-9a-f-]+$/u));
  });

  it("keeps ordinary failures visible without telemetry", async () => {
    const dependencies = createDependencies("reporter");
    const app = createApp({
      auth: dependencies.auth,
      memberships: dependencies.memberships,
      tenants: dependencies.tenants,
      webOrigin: dependencies.webOrigin
    });
    const failure = new Error("ordinary handler failure");
    app.get("/boom", () => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await app.request("/boom");
      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledWith(failure);
    } finally {
      consoleError.mockRestore();
    }
  });
});
