import { readFile } from "node:fs/promises";

import { createTenantRuntime, isUuidV7 } from "@zabuni/db";

import {
  buildItemSearchText,
  embeddingContentHash,
  FixtureEmbeddingProvider
} from "./embedding.js";
import { evaluateTopOne, type MatchEvaluationCase } from "./evaluation.js";
import { TenantCatalogMatcher } from "./matching.js";
import { TenantCatalogService } from "./service.js";

function parseCases(value: unknown): readonly MatchEvaluationCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Evaluation file must contain a non-empty JSON array");
  }
  const entries = value as readonly unknown[];
  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("query" in entry) ||
      typeof entry.query !== "string" ||
      !("expectedSku" in entry) ||
      typeof entry.expectedSku !== "string" ||
      entry.query.trim() === "" ||
      entry.expectedSku.trim() === ""
    ) {
      throw new Error("Each evaluation case requires nonblank query and expectedSku strings");
    }
    return { query: entry.query, expectedSku: entry.expectedSku };
  });
}

const datasetPath = process.argv[2];
const tenantId = process.argv[3];
const databaseUrl = process.env.DATABASE_URL;
if (datasetPath === undefined || tenantId === undefined || databaseUrl === undefined) {
  throw new Error(
    "Usage: DATABASE_URL=... pnpm --filter @zabuni/catalog eval:matching:fixture -- <dataset.json> <tenant-uuid>"
  );
}
if (!isUuidV7(tenantId)) throw new Error("Evaluation tenant must be a verified UUIDv7");

const cases = parseCases(JSON.parse(await readFile(datasetPath, "utf8")) as unknown);
const runtime = createTenantRuntime(databaseUrl);
try {
  const provider = new FixtureEmbeddingProvider();
  const catalog = await runtime.run(tenantId, (database) =>
    new TenantCatalogService(database, tenantId).list()
  );
  for (const item of catalog) {
    if (!item.active) continue;
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      const outcome = await matcher.refreshItemEmbedding(item.id, provider);
      if (outcome !== "refreshed" && outcome !== "unchanged") {
        throw new Error(`Could not prepare embedding for ${item.sku}`);
      }
    });
  }
  const report = await evaluateTopOne({
    cases,
    catalogIdentity: catalog.map((item) => ({
      sku: item.sku,
      contentHash: embeddingContentHash(buildItemSearchText(item))
    })),
    match: (query) =>
      runtime.run(tenantId, async (database) => {
        const result = await new TenantCatalogMatcher(database, tenantId).match(query, {
          provider
        });
        if (result.candidates[0]?.degraded === true) {
          throw new Error(
            "Evaluation top candidate unexpectedly lacked a compatible current vector"
          );
        }
        return result;
      })
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passesEightyPercent) process.exitCode = 1;
} finally {
  await runtime.close();
}
