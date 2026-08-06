import type { AuthServer, MembershipRuntime } from "@zabuni/auth";
import type { TenantRole, TenantRuntime } from "@zabuni/db";
import { describe, expect, it, vi } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

const identityId = "0197f000-0000-7000-8000-000000000001";
const tenantId = "0197f000-0000-7000-8000-000000000002";
const userId = "0197f000-0000-7000-8000-000000000003";

function dependencies(role: TenantRole) {
  const run = vi.fn(() => {
    throw new Error("tenant database should not be reached");
  });
  const auth = {
    api: {
      getSession: () =>
        Promise.resolve({
          user: { id: identityId },
          session: { expiresAt: new Date("2099-01-01T00:00:00Z") }
        })
    }
  } as unknown as AuthServer;
  const memberships = {
    resolve: () =>
      Promise.resolve({
        identityId,
        tenantId,
        userId,
        role,
        expiresAt: new Date("2099-01-01T00:00:00Z")
      }),
    provision: () => Promise.reject(new Error("not used")),
    close: () => Promise.resolve()
  } satisfies MembershipRuntime;
  const tenants = { run, close: () => Promise.resolve() } as unknown as TenantRuntime;
  return {
    run,
    app: createApp({
      auth,
      memberships,
      tenants,
      webOrigin: "http://localhost:3000"
    } satisfies AppDependencies)
  };
}

describe("catalog HTTP boundary", () => {
  it("denies catalog writes to read-only tenant members before database access", async () => {
    const { app, run } = dependencies("readonly");
    const response = await app.request("/catalog/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "catalog_write_denied" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns structured validation errors without entering a tenant transaction", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request("/catalog/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      readonly error?: unknown;
      readonly issues?: unknown;
    };
    expect(payload.error).toBe("catalog_validation_failed");
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unsupported import files before persistence", async () => {
    const { app, run } = dependencies("manager");
    const form = new FormData();
    form.set("file", new File(["sku,description"], "catalog.txt", { type: "text/plain" }));
    form.set("mapping", JSON.stringify({ sku: "sku", description: "description" }));
    const response = await app.request("/catalog/imports/preview", {
      method: "POST",
      body: form
    });
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "catalog_file_type_unsupported" });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps wrapped database uniqueness failures to a SKU conflict", async () => {
    const { app, run } = dependencies("owner");
    run.mockRejectedValueOnce(new Error("insert failed", { cause: { code: "23505" } }));
    const response = await app.request("/catalog/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sku: "DUP-1",
        description: "Duplicate fixture",
        taxClass: "exempt",
        active: true
      })
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "catalog_sku_conflict" });
  });

  it("rejects malformed item identifiers before database access", async () => {
    const { app, run } = dependencies("manager");
    const response = await app.request("/catalog/items/not-a-uuid", { method: "DELETE" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "catalog_item_id_invalid" });
    expect(run).not.toHaveBeenCalled();
  });
});
