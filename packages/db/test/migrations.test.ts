import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readMigrations } from "../src/migrate.js";

describe("forward-only migrations", () => {
  it("discovers the complete ordered Phase 0 F-2 sequence", async () => {
    const migrations = await readMigrations();

    expect(migrations.map(({ name }) => name)).toEqual([
      "0000_foundation.sql",
      "0001_tenancy.sql",
      "0002_items.sql",
      "0003_usage_events.sql",
      "0004_outbox.sql",
      "0005_rls.sql",
      "0006_auth.sql",
      "0007_outbox_worker.sql",
      "0008_observability.sql",
      "0009_outbox_claim_hardening.sql",
      "0010_catalog_imports.sql",
      "0011_items_sku_casefold.sql",
      "0012_tax_classification_workflow.sql",
      "0013_tax_classification_privileges.sql",
      "0014_tax_evidence_enforcement.sql",
      "0015_tax_evidence_preflight.sql",
      "0016_catalog_matching.sql"
    ]);
    expect(new Set(migrations.map(({ checksum }) => checksum)).size).toBe(migrations.length);
  });

  it("adds pgvector catalog embeddings and tenant aliases", async () => {
    const migrations = await readMigrations();
    const matching = migrations.find(({ name }) => name === "0016_catalog_matching.sql")?.sql ?? "";

    expect(matching).toContain("FROM pg_available_extensions");
    expect(matching).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(matching).toContain("embedding vector(1024) NOT NULL");
    expect(matching).toContain("USING hnsw (embedding vector_cosine_ops)");
    expect(matching).toContain("UNIQUE (tenant_id, item_id)");
    expect(matching).toContain(
      "FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id) ON DELETE CASCADE"
    );
    expect(matching).toContain("ON item_aliases (tenant_id, lower(alias_text))");
    expect(matching).toContain("source IN ('human', 'accepted_match')");
    expect(matching).toContain("CHECK (hit_count >= 0)");
    expect(matching).toContain("CREATE TABLE catalog_alias_quotas");
    expect(matching).toContain("CREATE TRIGGER item_aliases_limit_guard");
    expect(matching).toContain("CREATE TABLE catalog_match_rate_limits");
    expect(matching).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON item_embeddings, item_aliases TO zabuni_app"
    );
    for (const table of [
      "item_embeddings",
      "item_aliases",
      "catalog_alias_quotas",
      "catalog_match_rate_limits"
    ]) {
      expect(matching).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(matching).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(matching).toContain(`CREATE POLICY ${table}_boundary ON ${table} AS RESTRICTIVE`);
    }
  });

  it("adds retry-safe total-event LLM call metering", async () => {
    const migrations = await readMigrations();
    const observability =
      migrations.find(({ name }) => name === "0008_observability.sql")?.sql ?? "";

    expect(observability).toContain("'llm_call'");
    expect(observability).toContain("ADD COLUMN idempotency_key text");
    expect(observability).toContain("usage_events_tenant_idempotency_unique");
    expect(observability).toContain("WHERE idempotency_key IS NOT NULL");
    expect(observability).toContain("Total event cost in minor currency units");
  });

  it("enables and forces tenant RLS with restrictive boundaries", async () => {
    const migrations = await readMigrations();
    const rls = migrations.find(({ name }) => name === "0005_rls.sql")?.sql ?? "";

    for (const table of ["tenants", "users", "items", "usage_events", "outbox", "incidents"]) {
      expect(rls).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(rls).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(rls).toContain(`CREATE POLICY ${table}_boundary ON ${table} AS RESTRICTIVE`);
    }
    expect(rls).toContain("current_setting('app.tenant_id', true)");
  });

  it("sorts migration files and ignores unrelated files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zabuni-migrations-"));
    await Promise.all([
      writeFile(join(directory, "0001_second.sql"), "SELECT 2;"),
      writeFile(join(directory, "0000_first.sql"), "SELECT 1;"),
      writeFile(join(directory, "README.md"), "not a migration")
    ]);

    const migrations = await readMigrations(directory);
    expect(migrations.map(({ name }) => name)).toEqual(["0000_first.sql", "0001_second.sql"]);
  });

  it("keeps tax classification explicit and constrained", async () => {
    const migrations = await readMigrations();
    const itemsMigration = migrations.find(({ name }) => name === "0002_items.sql");

    expect(itemsMigration?.sql).toMatch(/tax_class text NOT NULL/u);
    expect(itemsMigration?.sql).not.toMatch(/tax_class text NOT NULL DEFAULT/u);
    expect(itemsMigration?.sql).toContain("'standard_16', 'zero_rated', 'exempt'");

    const catalogMigration = migrations.find(({ name }) => name === "0010_catalog_imports.sql");
    expect(catalogMigration?.sql).toMatch(/tax_class text,/u);
    expect(catalogMigration?.sql).not.toMatch(/tax_class text NOT NULL/u);
    expect(catalogMigration?.sql).toContain(
      "tax_class IS NULL OR tax_class IN ('standard_16', 'zero_rated', 'exempt')"
    );
  });

  it("never uses database-generated UUID defaults or floating-point money", async () => {
    const migrations = await readMigrations();
    const source = migrations.map(({ sql }) => sql).join("\n");

    expect(source).not.toMatch(/uuid[^,\n]*DEFAULT/iu);
    expect(source).not.toMatch(/\b(real|double precision|numeric|decimal)\b/iu);
    expect(source).toMatch(/cost_minor bigint/u);
    expect(source).toMatch(/unit_cost_minor bigint/u);
  });
});
