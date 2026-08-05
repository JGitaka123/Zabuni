import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("health", () => {
  it("reports readiness without external dependencies", async () => {
    const response = await createApp().request("/health");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
