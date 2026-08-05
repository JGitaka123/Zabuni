import { describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

describe("browser boundary", () => {
  it("allows credentials only for the configured web origin", async () => {
    const dependencies = {
      webOrigin: "http://localhost:3000"
    } as unknown as AppDependencies;
    const app = createApp(dependencies);

    const response = await app.request("/session-proof", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
