import { and, asc, cosineDistance, eq, ilike, or, sql } from "drizzle-orm";
import {
  createEntityId,
  isUuidV7,
  itemAliases,
  itemEmbeddings,
  items,
  type AliasSource,
  type TenantDatabase
} from "@zabuni/db";
import {
  assignCatalogItemAlias,
  confirmCatalogItemAlias,
  deleteCatalogItemAlias,
  deleteCatalogItemEmbedding,
  upsertCatalogItemEmbedding
} from "@zabuni/db/privileged/catalog-matching";

import {
  buildItemSearchText,
  embeddingContentHash,
  normalizeMatchText,
  validateEmbedding,
  type EmbeddingProvider
} from "./embedding.js";

const VECTOR_CANDIDATE_LIMIT = 100;
const LEXICAL_CANDIDATE_LIMIT = 250;
const MAX_RESULT_LIMIT = 25;

export const MATCHER_VERSION = "hybrid-v1";

export interface MatchScore {
  readonly alias: number;
  readonly lexical: number;
  readonly pack: -1 | 0 | 1;
  readonly unit: -1 | 0 | 1;
  readonly vector: number | null;
  readonly final: number;
}

export interface CatalogMatchCandidate {
  readonly itemId: string;
  readonly sku: string;
  readonly description: string;
  readonly method: "alias" | "hybrid" | "lexical" | "vector";
  readonly score: MatchScore;
  readonly degraded: boolean;
  readonly reasons: readonly string[];
}

export interface CatalogMatchResult {
  readonly normalizedQuery: string;
  readonly matcherVersion: typeof MATCHER_VERSION;
  readonly embedding: {
    readonly provider: string;
    readonly model: string;
    readonly version: string;
  } | null;
  readonly candidates: readonly CatalogMatchCandidate[];
}

export interface AliasRecord {
  readonly id: string;
  readonly itemId: string;
  readonly aliasText: string;
  readonly source: AliasSource;
  readonly hitCount: number;
  readonly lastUsedAt: Date | null;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token !== ""));
}

function diceCoefficient(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

interface CanonicalPack {
  readonly amount: number;
  readonly unit: "count" | "mass_g" | "volume_ml";
}

function canonicalPack(value: string): CanonicalPack | null {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)(ml|l|kg|g|pc)(?:\s|$)/u.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || unit === undefined) return null;
  if (unit === "l") return { amount: amount * 1_000, unit: "volume_ml" };
  if (unit === "ml") return { amount, unit: "volume_ml" };
  if (unit === "kg") return { amount: amount * 1_000, unit: "mass_g" };
  if (unit === "g") return { amount, unit: "mass_g" };
  return { amount, unit: "count" };
}

function comparePack(query: string, item: string): -1 | 0 | 1 {
  const queryPack = canonicalPack(query);
  const itemPack = canonicalPack(item);
  if (queryPack === null || itemPack === null) return 0;
  return queryPack.unit === itemPack.unit && queryPack.amount === itemPack.amount ? 1 : -1;
}

const knownUnits = new Set(["bottle", "box", "carton", "drum", "jar", "jerrican", "pack", "pc"]);

function explicitUnit(value: string): string | null {
  for (const token of value.split(" ")) if (knownUnits.has(token)) return token;
  return null;
}

function compareUnit(query: string, itemUom: string | null): -1 | 0 | 1 {
  if (itemUom === null || itemUom.trim() === "") return 0;
  const queryUnit = explicitUnit(query);
  const catalogUnit = explicitUnit(normalizeMatchText(itemUom));
  if (queryUnit === null || catalogUnit === null) return 0;
  return queryUnit === catalogUnit ? 1 : -1;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasDatabaseCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (Reflect.get(current, "code") === code) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

function finalScore(components: Omit<MatchScore, "final">): number {
  return clampScore(
    (components.vector ?? 0) * 0.4 +
      components.lexical * 0.2 +
      components.alias * 0.35 +
      components.pack * 0.03 +
      components.unit * 0.02
  );
}

function validateDescriptor(provider: EmbeddingProvider): void {
  const descriptor = provider.descriptor;
  const validPart = (value: string) => {
    if (value.trim() === "" || value.length > 100) return false;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) return false;
    }
    return true;
  };
  if (
    descriptor.dimensions !== 1_024 ||
    !validPart(descriptor.provider) ||
    !validPart(descriptor.model) ||
    !validPart(descriptor.version)
  ) {
    throw new Error("Embedding provider descriptor is invalid");
  }
}

/** Tenant-scoped embedding, alias, and hybrid matching operations. */
export class TenantCatalogMatcher {
  readonly #database: TenantDatabase;
  readonly #tenantId: string;

  constructor(database: TenantDatabase, verifiedTenantId: string) {
    if (!isUuidV7(verifiedTenantId)) throw new Error("Matcher tenant must be a verified UUIDv7");
    this.#database = database;
    this.#tenantId = verifiedTenantId;
  }

  async refreshItemEmbedding(
    itemId: string,
    provider: EmbeddingProvider
  ): Promise<"refreshed" | "unchanged" | "removed" | "not_found"> {
    if (!isUuidV7(itemId)) throw new Error("Embedding item must be a verified UUIDv7");
    validateDescriptor(provider);
    const [item] = await this.#database
      .select()
      .from(items)
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.id, itemId)))
      .limit(1);
    if (item === undefined) return "not_found";
    if (!item.active) {
      const removed = await deleteCatalogItemEmbedding(this.#database, itemId);
      return removed ? "removed" : "unchanged";
    }
    const normalizedText = buildItemSearchText(item);
    const contentHash = embeddingContentHash(normalizedText);
    const descriptor = provider.descriptor;
    const [existing] = await this.#database
      .select()
      .from(itemEmbeddings)
      .where(and(eq(itemEmbeddings.tenantId, this.#tenantId), eq(itemEmbeddings.itemId, itemId)))
      .limit(1);
    if (
      existing?.contentHash === contentHash &&
      existing.provider === descriptor.provider &&
      existing.model === descriptor.model &&
      existing.modelVersion === descriptor.version
    ) {
      return "unchanged";
    }
    const embedding = validateEmbedding(await provider.embed(normalizedText));
    await upsertCatalogItemEmbedding(this.#database, {
      itemId,
      embedding,
      normalizedText,
      contentHash,
      provider: descriptor.provider,
      model: descriptor.model,
      modelVersion: descriptor.version
    });
    return "refreshed";
  }

  async listAliases(
    itemId?: string,
    options: { readonly limit?: number; readonly offset?: number } = {}
  ): Promise<readonly AliasRecord[]> {
    if (itemId !== undefined && !isUuidV7(itemId)) {
      throw new Error("Alias item must be a verified UUIDv7");
    }
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error("Alias page is invalid");
    }
    const rows = await this.#database
      .select()
      .from(itemAliases)
      .where(
        itemId === undefined
          ? eq(itemAliases.tenantId, this.#tenantId)
          : and(eq(itemAliases.tenantId, this.#tenantId), eq(itemAliases.itemId, itemId))
      )
      .orderBy(asc(itemAliases.aliasText), asc(itemAliases.id))
      .limit(limit)
      .offset(offset);
    return rows;
  }

  async addAlias(input: {
    readonly itemId: string;
    readonly aliasText: string;
    readonly source: AliasSource;
    readonly reassign?: boolean;
  }): Promise<AliasRecord> {
    if (!isUuidV7(input.itemId)) throw new Error("Alias item must be a verified UUIDv7");
    const aliasText = normalizeMatchText(input.aliasText);
    const [item] = await this.#database
      .select({ id: items.id })
      .from(items)
      .where(
        and(eq(items.tenantId, this.#tenantId), eq(items.id, input.itemId), eq(items.active, true))
      )
      .limit(1);
    if (item === undefined) throw new Error("Alias item was not found or is inactive");

    let aliasId: string;
    try {
      aliasId = await assignCatalogItemAlias(this.#database, {
        aliasId: createEntityId(),
        itemId: input.itemId,
        aliasText,
        source: input.source,
        reassign: input.reassign === true
      });
    } catch (error) {
      if (hasDatabaseCode(error, "23514")) {
        throw new Error("Tenant alias limit reached", { cause: error });
      }
      throw error;
    }
    const [assigned] = await this.#database
      .select()
      .from(itemAliases)
      .where(and(eq(itemAliases.tenantId, this.#tenantId), eq(itemAliases.id, aliasId)))
      .limit(1);
    if (assigned === undefined) throw new Error("Alias assignment failed");
    return assigned;
  }

  async removeAlias(aliasId: string): Promise<boolean> {
    if (!isUuidV7(aliasId)) throw new Error("Alias must be a verified UUIDv7");
    return deleteCatalogItemAlias(this.#database, aliasId);
  }

  async confirmMatch(queryText: string, itemId: string): Promise<AliasRecord> {
    const alias = await this.addAlias({ itemId, aliasText: queryText, source: "accepted_match" });
    await confirmCatalogItemAlias(this.#database, alias.id);
    const [confirmed] = await this.#database
      .select()
      .from(itemAliases)
      .where(and(eq(itemAliases.tenantId, this.#tenantId), eq(itemAliases.id, alias.id)))
      .limit(1);
    if (confirmed === undefined) throw new Error("Alias confirmation failed");
    return confirmed;
  }

  async match(
    queryText: string,
    options: { readonly limit?: number; readonly provider?: EmbeddingProvider } = {}
  ): Promise<CatalogMatchResult> {
    const normalizedQuery = normalizeMatchText(queryText);
    const limit = options.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
      throw new Error("Match limit must be an integer from 1 to 25");
    }

    const queryTokens = [...new Set(normalizedQuery.split(" "))].slice(0, 12);
    const lexicalConditions = queryTokens.flatMap((token) => {
      const pattern = `%${token}%`;
      return [
        ilike(items.sku, pattern),
        ilike(items.description, pattern),
        ilike(items.brand, pattern),
        ilike(items.packSize, pattern),
        ilike(items.uom, pattern)
      ];
    });
    const lexicalPredicate = or(...lexicalConditions);
    if (lexicalPredicate === undefined)
      throw new Error("Match query produced no searchable tokens");
    const lexicalItems = await this.#database
      .select({
        id: items.id,
        sku: items.sku,
        description: items.description,
        brand: items.brand,
        packSize: items.packSize,
        uom: items.uom
      })
      .from(items)
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.active, true), lexicalPredicate))
      .orderBy(asc(items.sku), asc(items.id))
      .limit(LEXICAL_CANDIDATE_LIMIT);
    const exactAliases = await this.#database
      .select({
        aliasText: itemAliases.aliasText,
        id: items.id,
        sku: items.sku,
        description: items.description,
        brand: items.brand,
        packSize: items.packSize,
        uom: items.uom
      })
      .from(itemAliases)
      .innerJoin(
        items,
        and(
          eq(items.tenantId, itemAliases.tenantId),
          eq(items.id, itemAliases.itemId),
          eq(items.active, true)
        )
      )
      .where(
        and(
          eq(itemAliases.tenantId, this.#tenantId),
          sql`lower(${itemAliases.aliasText}) = ${normalizedQuery}`
        )
      )
      .limit(2);
    const aliasesByItem = new Map<string, string[]>();
    for (const alias of exactAliases) {
      const values = aliasesByItem.get(alias.id) ?? [];
      values.push(normalizeMatchText(alias.aliasText));
      aliasesByItem.set(alias.id, values);
    }

    const vectorByItem = new Map<string, number>();
    const itemById = new Map(lexicalItems.map((item) => [item.id, item] as const));
    for (const alias of exactAliases) itemById.set(alias.id, alias);
    let embeddingDescriptor: CatalogMatchResult["embedding"] = null;
    if (options.provider !== undefined) {
      validateDescriptor(options.provider);
      const descriptor = options.provider.descriptor;
      const queryEmbedding = validateEmbedding(await options.provider.embed(normalizedQuery));
      const distance = cosineDistance(itemEmbeddings.embedding, queryEmbedding);
      // The `+ 0` deliberately prevents the global HNSW path here. Exact
      // tenant-filtered ranking avoids cross-tenant noisy-neighbour loss; the
      // HNSW index remains available for a future tenant-partitioned strategy.
      const exactDistance = sql<number>`(${distance}) + 0.0::float8`;
      const vectorRows = await this.#database
        .select({
          id: items.id,
          sku: items.sku,
          description: items.description,
          brand: items.brand,
          packSize: items.packSize,
          uom: items.uom,
          contentHash: itemEmbeddings.contentHash,
          similarity: sql<number>`1 - (${distance})`
        })
        .from(itemEmbeddings)
        .innerJoin(
          items,
          and(
            eq(items.tenantId, itemEmbeddings.tenantId),
            eq(items.id, itemEmbeddings.itemId),
            eq(items.active, true)
          )
        )
        .where(
          and(
            eq(itemEmbeddings.tenantId, this.#tenantId),
            eq(itemEmbeddings.provider, descriptor.provider),
            eq(itemEmbeddings.model, descriptor.model),
            eq(itemEmbeddings.modelVersion, descriptor.version)
          )
        )
        .orderBy(exactDistance, asc(itemEmbeddings.itemId))
        .limit(VECTOR_CANDIDATE_LIMIT);
      for (const row of vectorRows) {
        if (row.contentHash === embeddingContentHash(buildItemSearchText(row))) {
          itemById.set(row.id, row);
          vectorByItem.set(row.id, clampScore(row.similarity));
        }
      }
      embeddingDescriptor = {
        provider: descriptor.provider,
        model: descriptor.model,
        version: descriptor.version
      };
    }

    const activeItems = [...itemById.values()];
    if (activeItems.length === 0) {
      return {
        normalizedQuery,
        matcherVersion: MATCHER_VERSION,
        embedding: embeddingDescriptor,
        candidates: []
      };
    }

    const candidates = activeItems.map((item): CatalogMatchCandidate => {
      const itemText = buildItemSearchText(item);
      const itemAliases = aliasesByItem.get(item.id) ?? [];
      const exactAlias = itemAliases.includes(normalizedQuery);
      const lexical = Math.max(
        diceCoefficient(normalizedQuery, itemText),
        ...itemAliases.map((alias) => diceCoefficient(normalizedQuery, alias))
      );
      const vector = vectorByItem.get(item.id) ?? null;
      const components = {
        alias: exactAlias ? 1 : 0,
        lexical: clampScore(lexical),
        pack: comparePack(normalizedQuery, itemText),
        unit: compareUnit(normalizedQuery, item.uom),
        vector
      } as const;
      const reasons: string[] = [];
      if (exactAlias) reasons.push("exact tenant alias");
      if (components.pack === 1) reasons.push("pack size agrees");
      if (components.pack === -1) reasons.push("pack size conflicts");
      if (components.unit === 1) reasons.push("unit agrees");
      if (components.unit === -1) reasons.push("unit conflicts");
      if (vector === null) reasons.push("compatible current embedding unavailable");
      const method = exactAlias
        ? "alias"
        : vector !== null && components.lexical > 0
          ? "hybrid"
          : vector !== null
            ? "vector"
            : "lexical";
      return {
        itemId: item.id,
        sku: item.sku,
        description: item.description,
        method,
        score: { ...components, final: finalScore(components) },
        degraded: vector === null,
        reasons
      };
    });
    candidates.sort(
      (left, right) =>
        right.score.final - left.score.final ||
        compareCodePoint(normalizeMatchText(left.sku), normalizeMatchText(right.sku)) ||
        compareCodePoint(left.itemId, right.itemId)
    );
    return {
      normalizedQuery,
      matcherVersion: MATCHER_VERSION,
      embedding: embeddingDescriptor,
      candidates: candidates.slice(0, limit)
    };
  }
}
