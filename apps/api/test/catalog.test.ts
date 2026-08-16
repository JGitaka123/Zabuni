import type { AuthServer, MembershipRuntime } from "@zabuni/auth";
import { CatalogRateLimitError } from "@zabuni/catalog";
import type { TenantRole, TenantRuntime } from "@zabuni/db";
import { describe, expect, it, vi } from "vitest";

import { createApp, type AppDependencies } from "../src/app.js";

const identityId = "0197f000-0000-7000-8000-000000000001";
const tenantId = "0197f000-0000-7000-8000-000000000002";
const userId = "0197f000-0000-7000-8000-000000000003";

function dependencies(
  role: TenantRole,
  authenticated = true,
  telemetry?: AppDependencies["telemetry"]
) {
  const run = vi.fn(() => {
    throw new Error("tenant database should not be reached");
  });
  const auth = {
    api: {
      getSession: () =>
        Promise.resolve(
          authenticated
            ? {
                user: { id: identityId },
                session: { expiresAt: new Date("2099-01-01T00:00:00Z") }
              }
            : null
        )
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
    ping: () => Promise.resolve(),
    close: () => Promise.resolve()
  } satisfies MembershipRuntime;
  const tenants = { run, close: () => Promise.resolve() } as unknown as TenantRuntime;
  return {
    run,
    app: createApp({
      auth,
      memberships,
      tenants,
      webOrigin: "http://localhost:3000",
      ...(telemetry === undefined ? {} : { telemetry })
    } satisfies AppDependencies)
  };
}

describe("catalog HTTP boundary", () => {
  it("rejects an oversized multipart request before parsing its file", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request("/catalog/imports/inspect", {
      method: "POST",
      headers: {
        "content-length": String(12 * 1024 * 1024),
        "content-type": "multipart/form-data; boundary=catalog-test"
      },
      body: "--catalog-test--\r\n"
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "catalog_request_too_large" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed multipart request without content-length", async () => {
    const { app, run } = dependencies("owner");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const chunk = new Uint8Array(6 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      }
    });
    const request = new Request("http://localhost/catalog/imports/preview", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=catalog-test" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    try {
      const response = await app.request(request);
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "catalog_request_too_large" });
      expect(consoleError).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not report an oversized streamed request as an internal incident", async () => {
    const logError = vi.fn();
    const capture = vi.fn();
    const { app, run } = dependencies("owner", true, {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: logError
      },
      errors: { enabled: true, capture }
    });
    const chunk = new Uint8Array(6 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      }
    });
    const request = new Request("http://localhost/catalog/imports/inspect", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=catalog-test" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const response = await app.request(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "catalog_request_too_large" });
    expect(logError).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("authenticates before applying the multipart request limit", async () => {
    const { app, run } = dependencies("owner", false);
    const response = await app.request("/catalog/imports/inspect", {
      method: "POST",
      headers: {
        "content-length": String(12 * 1024 * 1024),
        "content-type": "multipart/form-data; boundary=catalog-test"
      },
      body: "--catalog-test--\r\n"
    });
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("retains the stricter per-file limit within the multipart allowance", async () => {
    const { app, run } = dependencies("owner");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "catalog.csv", { type: "text/csv" })
    );
    const response = await app.request("/catalog/imports/inspect", {
      method: "POST",
      body: form
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "catalog_file_size_invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects JSON mutations sent as a simple text request", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request("/catalog/matches", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ query: "hand wash" })
    });
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_media_type" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-multipart catalog upload requests", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request("/catalog/imports/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_media_type" });
    expect(run).not.toHaveBeenCalled();
  });

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
        taxClassificationBasis: "Reviewed fixture source",
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

  it("keeps tax classification authority limited to owner and manager", async () => {
    const { app, run } = dependencies("finance");
    const response = await app.request(`/catalog/imports/${tenantId}/rows/2/tax-class`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taxClass: "exempt",
        basisNote: "Finance role must not be able to make this decision"
      })
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "catalog_write_denied" });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires an exact tax class and nonblank classification basis", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request(`/catalog/imports/${tenantId}/rows/2/tax-class`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taxClass: "16%", basisNote: "" })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "catalog_classification_invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps wrapped stale classification decisions to a conflict", async () => {
    const { app, run } = dependencies("manager");
    run.mockRejectedValueOnce(new Error("classification failed", { cause: { code: "23514" } }));
    const response = await app.request(`/catalog/imports/${tenantId}/rows/2/tax-class`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taxClass: "exempt",
        basisNote: "Reviewed fixture evidence"
      })
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "catalog_classification_conflict" });
  });

  it("rejects malformed classification JSON without database access", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request(`/catalog/imports/${tenantId}/rows/2/tax-class`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects malformed match requests before database access", async () => {
    const { app, run } = dependencies("sales");
    const response = await app.request("/catalog/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "", limit: 0 })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "catalog_match_invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("limits learned match corrections to sales, manager, and owner roles", async () => {
    const { app, run } = dependencies("finance");
    const response = await app.request("/catalog/matches/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hand wash 5l", itemId: tenantId })
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "catalog_match_confirmation_denied"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("restricts direct alias administration to owner and manager", async () => {
    const { app, run } = dependencies("sales");
    const response = await app.request("/catalog/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: tenantId, aliasText: "hand wash" })
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "catalog_write_denied" });
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces a missing production embedding provider without touching the database", async () => {
    const { app, run } = dependencies("owner");
    const response = await app.request(`/catalog/items/${tenantId}/embedding`, {
      method: "POST"
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "catalog_embedding_provider_unavailable"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns an explainable successful match through the tenant boundary", async () => {
    const { app, run } = dependencies("readonly");
    (run as unknown as { mockResolvedValueOnce(value: unknown): void }).mockResolvedValueOnce(
      undefined
    );
    (run as unknown as { mockResolvedValueOnce(value: unknown): void }).mockResolvedValueOnce({
      normalizedQuery: "hand wash 5l",
      matcherVersion: "hybrid-v1",
      embedding: null,
      candidates: [
        {
          itemId: tenantId,
          sku: "HW-5L",
          description: "Antibacterial hand soap",
          method: "lexical",
          score: { alias: 0, lexical: 0.8, pack: 1, unit: 0, vector: null, final: 0.19 },
          degraded: true,
          reasons: ["pack size agrees", "compatible current embedding unavailable"]
        }
      ]
    });
    const response = await app.request("/catalog/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hand wash 5 litres", limit: 3 })
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { readonly candidates?: readonly unknown[] };
    expect(payload.candidates).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(tenantId, expect.any(Function));
  });

  it("returns a shared match rate-limit response", async () => {
    const { app, run } = dependencies("sales");
    run.mockRejectedValueOnce(new CatalogRateLimitError());
    const response = await app.request("/catalog/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hand wash 5 litres" })
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "catalog_match_rate_limited" });
  });

  it("allows a sales user to record a confirmed correction", async () => {
    const { app, run } = dependencies("sales");
    (run as unknown as { mockResolvedValueOnce(value: unknown): void }).mockResolvedValueOnce(
      undefined
    );
    (run as unknown as { mockResolvedValueOnce(value: unknown): void }).mockResolvedValueOnce({
      id: tenantId,
      itemId: tenantId,
      aliasText: "pink soap 5l",
      source: "accepted_match",
      hitCount: 1,
      lastUsedAt: new Date("2026-08-07T00:00:00Z")
    });
    const response = await app.request("/catalog/matches/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pink soap 5l", itemId: tenantId })
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { readonly alias?: { readonly hitCount?: unknown } };
    expect(payload.alias?.hitCount).toBe(1);
    expect(run).toHaveBeenCalledWith(tenantId, expect.any(Function));
  });

  it("returns a shared alias-write rate-limit response", async () => {
    const { app, run } = dependencies("sales");
    run.mockRejectedValueOnce(new CatalogRateLimitError());
    const response = await app.request("/catalog/matches/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hand wash 5 litres", itemId: tenantId })
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "catalog_alias_rate_limited" });
  });
});
