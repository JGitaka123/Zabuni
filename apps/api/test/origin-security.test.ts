import type { AuthServer, MembershipRuntime } from "@zabuni/auth";
import type { TenantRuntime } from "@zabuni/db";
import { describe, expect, it, vi } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

const webOrigin = "https://app.zabuni.test";

function dependencies() {
  const handler = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
  const auth = {
    handler,
    api: { getSession: () => Promise.resolve(null) }
  } as unknown as AuthServer;
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
    handler,
    app: createApp({ auth, memberships, tenants, webOrigin } satisfies AppDependencies)
  };
}

describe("browser mutation origin boundary", () => {
  it.each([
    ["missing", undefined],
    ["foreign", "https://attacker.example"]
  ])("rejects a %s Origin on a cookie-authenticated mutation", async (_label, origin) => {
    const { app } = dependencies();
    const headers = new Headers({
      cookie: "better-auth.session_token=fixture",
      "content-type": "application/json"
    });
    if (origin !== undefined) headers.set("origin", origin);

    const response = await app.request("/onboarding", {
      method: "POST",
      headers,
      body: JSON.stringify({ legalName: "Boundary Test Ltd" })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "browser_origin_denied" });
  });

  it("allows the configured Origin through to normal authentication", async () => {
    const { app } = dependencies();
    const response = await app.request("/onboarding", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=fixture",
        "content-type": "application/json",
        origin: webOrigin
      },
      body: JSON.stringify({ legalName: "Boundary Test Ltd" })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("leaves Better Auth routes under Better Auth's trusted-origin handling", async () => {
    const { app, handler } = dependencies();
    const response = await app.request("/auth/sign-in/email-otp", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=fixture",
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: "{}"
    });

    expect(response.status).toBe(202);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not require Origin on safe methods", async () => {
    const { app } = dependencies();
    const response = await app.request("/session-proof", {
      headers: { cookie: "better-auth.session_token=fixture" }
    });
    expect(response.status).toBe(401);
  });

  it("rejects a misleading JSON content type", async () => {
    const { app } = dependencies();
    const response = await app.request("/onboarding", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=fixture",
        "content-type": "text/plain",
        origin: webOrigin
      },
      body: JSON.stringify({ legalName: "Boundary Test Ltd" })
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_media_type" });
  });
});
