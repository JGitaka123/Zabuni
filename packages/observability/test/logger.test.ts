import { describe, expect, it, vi } from "vitest";

import { createStructuredLogger, type PinoCompatibleLogger } from "../src/logger.js";

function sink() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } satisfies PinoCompatibleLogger;
}

describe("createStructuredLogger", () => {
  it("writes structured, redacted records through the Pino facade", () => {
    const target = sink();
    const logger = createStructuredLogger(target, {
      service: "api",
      environment: "test"
    });

    logger.info(
      "session.started",
      { correlationId: "correlation-1", requestId: "request-1", tenantId: "tenant-a" },
      { phone: "+254712345678" }
    );

    expect(target.info).toHaveBeenCalledWith(
      {
        service: "api",
        environment: "test",
        event: "session.started",
        correlationId: "correlation-1",
        requestId: "request-1",
        tenantId: "tenant-a",
        attributes: { phone: "[REDACTED]" }
      },
      "session.started"
    );
  });

  it("supports every level and rejects blank labels", () => {
    const target = sink();
    const logger = createStructuredLogger(target, { service: "worker", environment: "test" });
    const context = { correlationId: "correlation-1", jobId: "job-1" };
    logger.debug("debugged", context);
    logger.warn("warned", context);
    logger.error("failed", context);
    expect(target.debug).toHaveBeenCalledOnce();
    expect(target.warn).toHaveBeenCalledOnce();
    expect(target.error).toHaveBeenCalledOnce();
    expect(() => {
      logger.info(" ", context);
    }).toThrow(/event/);
    expect(() => {
      logger.info("valid", { correlationId: "unsafe phone +254712345678" });
    }).toThrow(/telemetry-safe/);
    expect(() => createStructuredLogger(target, { service: "", environment: "test" })).toThrow(
      /service/
    );
  });
});
