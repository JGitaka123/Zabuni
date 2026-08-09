import type { MembershipRuntime, AuthServer } from "@zabuni/auth";
import type { TenantRuntime } from "@zabuni/db";
import { describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

function createDependencies(readiness: () => Promise<void>): AppDependencies {
  const auth = { handler: () => new Response(null, { status: 404 }) } as unknown as AuthServer;
  const memberships = {
    resolve: () => Promise.resolve(null),
    provision: () => Promise.reject(new Error("not used")),
    ping: readiness,
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
    readiness,
    webOrigin: "http://localhost:3000"
  };
}

describe("readiness probe", () => {
  it("reports ready when dependencies answer", async () => {
    const app = createApp(createDependencies(() => Promise.resolve()));
    const response = await app.request("/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("sheds traffic with 503 when the database is unreachable", async () => {
    const app = createApp(
      createDependencies(() => Promise.reject(new Error("connection refused")))
    );
    const response = await app.request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unready" });
  });

  it("does not leak the underlying failure to the caller", async () => {
    const app = createApp(
      createDependencies(() =>
        Promise.reject(new Error("password authentication failed for user zabuni_app"))
      )
    );
    const body = await (await app.request("/ready")).text();

    expect(body).not.toContain("zabuni_app");
    expect(body).not.toContain("password");
  });

  it("keeps liveness independent of dependency health", async () => {
    const app = createApp(
      createDependencies(() => Promise.reject(new Error("connection refused")))
    );
    const response = await app.request("/health");

    // A database outage must not make an orchestrator restart a healthy process.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
