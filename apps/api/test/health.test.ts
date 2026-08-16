import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("health", () => {
  it("reports readiness without external dependencies", async () => {
    const response = await createApp().request("/health");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("sets the API security-header baseline", async () => {
    const response = await createApp().request("/health");

    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });
});
