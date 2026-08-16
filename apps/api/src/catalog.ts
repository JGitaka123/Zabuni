import {
  catalogFields,
  acquireCatalogMatchConcurrency,
  CatalogRateLimitError,
  CatalogMappingError,
  CatalogValidationError,
  consumeCatalogRequestRate,
  normalizeMatchText,
  parseCsv,
  parseXlsx,
  previewImport,
  serializeCatalogItem,
  TenantCatalogMatcher,
  TenantCatalogService,
  validateCatalogInput,
  type CatalogInput,
  type ColumnMapping,
  type EmbeddingProvider,
  type TaxClass
} from "@zabuni/catalog";
import type { AuthServer, MembershipRuntime } from "@zabuni/auth";
import type { TenantRole, TenantRuntime } from "@zabuni/db";
import { isUuidV7 } from "@zabuni/db";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { requireTenantSession, type SessionVariables } from "./middleware/session.js";

const MAX_CATALOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CATALOG_REQUEST_BYTES = MAX_CATALOG_FILE_BYTES + 1024 * 1024;
const catalogFieldSet = new Set<string>(catalogFields);
const taxClassSet = new Set<TaxClass>(["standard_16", "zero_rated", "exempt"]);
const catalogJsonBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (context) => context.json({ error: "catalog_request_too_large" }, 413)
});
const catalogUploadBodyLimit = bodyLimit({
  maxSize: MAX_CATALOG_REQUEST_BYTES,
  onError: (context) => context.json({ error: "catalog_request_too_large" }, 413)
});

interface CatalogDependencies {
  readonly auth: AuthServer;
  readonly memberships: MembershipRuntime;
  readonly tenants: TenantRuntime;
  readonly embeddingProvider?: EmbeddingProvider;
}

function mayWriteCatalog(role: TenantRole): boolean {
  return role === "owner" || role === "manager";
}

function mayConfirmMatch(role: TenantRole): boolean {
  return mayWriteCatalog(role) || role === "sales";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappingFromJson(value: string): ColumnMapping {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("mapping must be a JSON object");
  }
  const mapping: Partial<Record<(typeof catalogFields)[number], string>> = {};
  for (const [field, heading] of Object.entries(parsed)) {
    if (!catalogFieldSet.has(field) || typeof heading !== "string" || heading.trim() === "") {
      throw new Error("mapping contains an invalid catalog field or heading");
    }
    mapping[field as (typeof catalogFields)[number]] = heading;
  }
  return mapping;
}

function validationResponse(error: unknown): { readonly error: string; readonly issues?: unknown } {
  if (error instanceof CatalogMappingError || error instanceof CatalogValidationError) {
    return { error: "catalog_validation_failed", issues: error.issues };
  }
  return { error: "catalog_validation_failed" };
}

function isUniqueViolation(error: unknown): boolean {
  return hasErrorCode(error, "23505");
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (Reflect.get(current, "code") === code) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

function isBodyLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "BodyLimitError" &&
    error.message === "Payload Too Large"
  );
}

function isValidClassificationBasis(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1_000) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

async function parseUploadedCatalog(upload: File) {
  if (upload.size === 0 || upload.size > MAX_CATALOG_FILE_BYTES) {
    throw new RangeError("catalog_file_size_invalid");
  }
  const bytes = Buffer.from(await upload.arrayBuffer());
  const lowerName = upload.name.toLocaleLowerCase("en-KE");
  if (lowerName.endsWith(".csv")) return parseCsv(bytes);
  if (lowerName.endsWith(".xlsx")) return parseXlsx(bytes);
  return undefined;
}

export function registerCatalogRoutes(
  app: Hono<{ Variables: SessionVariables }>,
  dependencies: CatalogDependencies
): void {
  if (
    dependencies.embeddingProvider !== undefined &&
    dependencies.embeddingProvider.descriptor.provider !== "fixture"
  ) {
    throw new Error(
      "Request-path embedding is restricted to the offline fixture provider; production embedding must run outside database transactions"
    );
  }
  const tenantSession = requireTenantSession(dependencies.auth, dependencies.memberships);
  app.get("/catalog/items", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    const rows = await dependencies.tenants.run(session.tenantId, async (database) => {
      const catalog = new TenantCatalogService(database, session.tenantId);
      return catalog.list();
    });
    return context.json({ items: rows.map(serializeCatalogItem) });
  });

  app.post("/catalog/matches", catalogJsonBodyLimit, tenantSession, async (context) => {
    const session = context.get("tenantSession");
    try {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "catalog_match_invalid" }, 400);
      }
      if (!isJsonObject(body) || typeof body.query !== "string") {
        return context.json({ error: "catalog_match_invalid" }, 400);
      }
      try {
        normalizeMatchText(body.query);
      } catch {
        return context.json({ error: "catalog_match_invalid" }, 400);
      }
      const limit = body.limit === undefined ? undefined : body.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 25)
      ) {
        return context.json({ error: "catalog_match_invalid" }, 400);
      }
      await dependencies.tenants.run(session.tenantId, (database) =>
        consumeCatalogRequestRate(database, session.userId, "match")
      );
      const result = await dependencies.tenants.run(session.tenantId, async (database) => {
        await acquireCatalogMatchConcurrency(database, session.tenantId, session.userId);
        const matcher = new TenantCatalogMatcher(database, session.tenantId);
        return matcher.match(body.query as string, {
          ...(limit === undefined ? {} : { limit }),
          ...(dependencies.embeddingProvider === undefined
            ? {}
            : { provider: dependencies.embeddingProvider })
        });
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof Error && /Match text|Match limit/u.test(error.message)) {
        return context.json({ error: "catalog_match_invalid" }, 400);
      }
      if (error instanceof CatalogRateLimitError) {
        return context.json({ error: "catalog_match_rate_limited" }, 429);
      }
      throw error;
    }
  });

  app.post("/catalog/matches/confirm", catalogJsonBodyLimit, tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayConfirmMatch(session.role)) {
      return context.json({ error: "catalog_match_confirmation_denied" }, 403);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "catalog_match_confirmation_invalid" }, 400);
    }
    if (
      !isJsonObject(body) ||
      typeof body.query !== "string" ||
      typeof body.itemId !== "string" ||
      !isUuidV7(body.itemId)
    ) {
      return context.json({ error: "catalog_match_confirmation_invalid" }, 400);
    }
    try {
      await dependencies.tenants.run(session.tenantId, (database) =>
        consumeCatalogRequestRate(database, session.userId, "alias")
      );
      const alias = await dependencies.tenants.run(session.tenantId, async (database) => {
        const matcher = new TenantCatalogMatcher(database, session.tenantId);
        return matcher.confirmMatch(body.query as string, body.itemId as string);
      });
      return context.json({ alias }, 201);
    } catch (error) {
      if (
        isUniqueViolation(error) ||
        (error instanceof Error && error.message.includes("assigned"))
      ) {
        return context.json({ error: "catalog_alias_conflict" }, 409);
      }
      if (error instanceof Error && /safe characters|not found|inactive/u.test(error.message)) {
        return context.json({ error: "catalog_match_confirmation_invalid" }, 400);
      }
      if (error instanceof Error && error.message.includes("alias limit")) {
        return context.json({ error: "catalog_alias_limit_reached" }, 409);
      }
      if (error instanceof CatalogRateLimitError) {
        return context.json({ error: "catalog_alias_rate_limited" }, 429);
      }
      throw error;
    }
  });

  app.get("/catalog/aliases", tenantSession, async (context) => {
    const itemId = context.req.query("itemId");
    const limit = Number(context.req.query("limit") ?? "100");
    const offset = Number(context.req.query("offset") ?? "0");
    if (itemId !== undefined && !isUuidV7(itemId)) {
      return context.json({ error: "catalog_item_id_invalid" }, 400);
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      return context.json({ error: "catalog_alias_page_invalid" }, 400);
    }
    const session = context.get("tenantSession");
    const aliases = await dependencies.tenants.run(session.tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, session.tenantId);
      return matcher.listAliases(itemId, { limit, offset });
    });
    return context.json({ aliases });
  });

  app.post("/catalog/aliases", catalogJsonBodyLimit, tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "catalog_alias_invalid" }, 400);
    }
    if (
      !isJsonObject(body) ||
      typeof body.itemId !== "string" ||
      !isUuidV7(body.itemId) ||
      typeof body.aliasText !== "string" ||
      (body.reassign !== undefined && typeof body.reassign !== "boolean")
    ) {
      return context.json({ error: "catalog_alias_invalid" }, 400);
    }
    try {
      await dependencies.tenants.run(session.tenantId, (database) =>
        consumeCatalogRequestRate(database, session.userId, "alias")
      );
      const alias = await dependencies.tenants.run(session.tenantId, async (database) => {
        const matcher = new TenantCatalogMatcher(database, session.tenantId);
        return matcher.addAlias({
          itemId: body.itemId as string,
          aliasText: body.aliasText as string,
          source: "human",
          ...(body.reassign === true ? { reassign: true } : {})
        });
      });
      return context.json({ alias }, 201);
    } catch (error) {
      if (
        isUniqueViolation(error) ||
        (error instanceof Error && error.message.includes("assigned"))
      ) {
        return context.json({ error: "catalog_alias_conflict" }, 409);
      }
      if (error instanceof Error && /safe characters|not found|inactive/u.test(error.message)) {
        return context.json({ error: "catalog_alias_invalid" }, 400);
      }
      if (error instanceof Error && error.message.includes("alias limit")) {
        return context.json({ error: "catalog_alias_limit_reached" }, 409);
      }
      if (error instanceof CatalogRateLimitError) {
        return context.json({ error: "catalog_alias_rate_limited" }, 429);
      }
      throw error;
    }
  });

  app.delete("/catalog/aliases/:aliasId", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    const aliasId = context.req.param("aliasId");
    if (!isUuidV7(aliasId)) return context.json({ error: "catalog_alias_id_invalid" }, 400);
    let removed: boolean;
    try {
      await dependencies.tenants.run(session.tenantId, (database) =>
        consumeCatalogRequestRate(database, session.userId, "alias")
      );
      removed = await dependencies.tenants.run(session.tenantId, async (database) => {
        const matcher = new TenantCatalogMatcher(database, session.tenantId);
        return matcher.removeAlias(aliasId);
      });
    } catch (error) {
      if (error instanceof CatalogRateLimitError) {
        return context.json({ error: "catalog_alias_rate_limited" }, 429);
      }
      throw error;
    }
    if (!removed) return context.json({ error: "catalog_alias_not_found" }, 404);
    return context.json({ removed: true });
  });

  app.post("/catalog/items/:itemId/embedding", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    const itemId = context.req.param("itemId");
    if (!isUuidV7(itemId)) return context.json({ error: "catalog_item_id_invalid" }, 400);
    const embeddingProvider = dependencies.embeddingProvider;
    if (embeddingProvider === undefined) {
      return context.json({ error: "catalog_embedding_provider_unavailable" }, 503);
    }
    const outcome = await dependencies.tenants.run(session.tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, session.tenantId);
      return matcher.refreshItemEmbedding(itemId, embeddingProvider);
    });
    if (outcome === "not_found") return context.json({ error: "catalog_item_not_found" }, 404);
    return context.json({ outcome });
  });

  app.post("/catalog/items", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    let input: CatalogInput;
    let taxClassificationBasis: string;
    try {
      const body: unknown = await context.req.json();
      input = validateCatalogInput(body);
      const basis =
        typeof body === "object" && body !== null && "taxClassificationBasis" in body
          ? body.taxClassificationBasis
          : undefined;
      if (!isValidClassificationBasis(basis)) {
        return context.json({ error: "tax_classification_basis_required" }, 400);
      }
      taxClassificationBasis = basis;
    } catch (error) {
      return context.json(validationResponse(error), 400);
    }
    try {
      const created = await dependencies.tenants.run(session.tenantId, async (database) => {
        const catalog = new TenantCatalogService(database, session.tenantId);
        return catalog.create(input, {
          classifiedByUserId: session.userId,
          basisNote: taxClassificationBasis
        });
      });
      return context.json({ item: serializeCatalogItem(created) }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "catalog_sku_conflict" }, 409);
      if (hasErrorCode(error, "23514")) {
        return context.json({ error: "catalog_tax_classification_conflict" }, 409);
      }
      throw error;
    }
  });

  app.put("/catalog/items/:itemId", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    if (!isUuidV7(context.req.param("itemId"))) {
      return context.json({ error: "catalog_item_id_invalid" }, 400);
    }
    let input: CatalogInput;
    let taxClassificationBasis: string;
    try {
      const body: unknown = await context.req.json();
      input = validateCatalogInput(body);
      const basis =
        typeof body === "object" && body !== null && "taxClassificationBasis" in body
          ? body.taxClassificationBasis
          : undefined;
      if (!isValidClassificationBasis(basis)) {
        return context.json({ error: "tax_classification_basis_required" }, 400);
      }
      taxClassificationBasis = basis;
    } catch (error) {
      return context.json(validationResponse(error), 400);
    }
    try {
      const updated = await dependencies.tenants.run(session.tenantId, async (database) => {
        const catalog = new TenantCatalogService(database, session.tenantId);
        return catalog.update(context.req.param("itemId"), input, {
          classifiedByUserId: session.userId,
          basisNote: taxClassificationBasis
        });
      });
      if (updated === undefined) return context.json({ error: "catalog_item_not_found" }, 404);
      return context.json({ item: serializeCatalogItem(updated) });
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "catalog_sku_conflict" }, 409);
      if (hasErrorCode(error, "23514")) {
        return context.json({ error: "catalog_tax_classification_conflict" }, 409);
      }
      throw error;
    }
  });

  app.delete("/catalog/items/:itemId", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    if (!isUuidV7(context.req.param("itemId"))) {
      return context.json({ error: "catalog_item_id_invalid" }, 400);
    }
    const archived = await dependencies.tenants.run(session.tenantId, async (database) => {
      const catalog = new TenantCatalogService(database, session.tenantId);
      return catalog.archive(context.req.param("itemId"));
    });
    if (!archived) return context.json({ error: "catalog_item_not_found" }, 404);
    return context.json({ archived: true });
  });

  app.put("/catalog/items/:itemId/tax-class", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    const itemId = context.req.param("itemId");
    if (!isUuidV7(itemId)) return context.json({ error: "catalog_item_id_invalid" }, 400);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "catalog_classification_invalid" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return context.json({ error: "catalog_classification_invalid" }, 400);
    }
    const taxClass: unknown = "taxClass" in body ? body.taxClass : undefined;
    const basisNote: unknown = "basisNote" in body ? body.basisNote : undefined;
    if (
      typeof taxClass !== "string" ||
      !taxClassSet.has(taxClass as TaxClass) ||
      !isValidClassificationBasis(basisNote)
    ) {
      return context.json({ error: "catalog_classification_invalid" }, 400);
    }
    try {
      const updated = await dependencies.tenants.run(session.tenantId, async (database) => {
        const catalog = new TenantCatalogService(database, session.tenantId);
        return catalog.reclassifyItem(itemId, taxClass as TaxClass, {
          classifiedByUserId: session.userId,
          basisNote
        });
      });
      if (updated === undefined) return context.json({ error: "catalog_item_not_found" }, 404);
      return context.json({ item: serializeCatalogItem(updated) });
    } catch (error) {
      if (
        hasErrorCode(error, "23514") ||
        (error instanceof Error && error.message.includes("unchanged"))
      ) {
        return context.json({ error: "catalog_tax_classification_conflict" }, 409);
      }
      throw error;
    }
  });

  app.post("/catalog/imports/preview", tenantSession, catalogUploadBodyLimit, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    try {
      const body = await context.req.parseBody();
      const upload = body.file;
      const rawMapping = body.mapping;
      if (!(upload instanceof File) || typeof rawMapping !== "string") {
        return context.json({ error: "catalog_file_and_mapping_required" }, 400);
      }
      const mapping = mappingFromJson(rawMapping);
      const table = await parseUploadedCatalog(upload);
      if (table === undefined) return context.json({ error: "catalog_file_type_unsupported" }, 415);
      const preview = previewImport(table, mapping);
      const catalogImport = await dependencies.tenants.run(session.tenantId, async (database) => {
        const catalog = new TenantCatalogService(database, session.tenantId);
        return catalog.stageImport(upload.name, preview, session.userId);
      });
      return context.json(
        {
          importId: catalogImport.id,
          headers: preview.headers,
          counts: {
            total: preview.rows.length,
            valid: preview.validCount,
            staged: preview.stagedCount,
            rejected: preview.rejectedCount
          },
          rows: preview.rows
        },
        201
      );
    } catch (error) {
      if (isBodyLimitError(error)) throw error;
      return context.json(validationResponse(error), 400);
    }
  });

  app.post("/catalog/imports/inspect", tenantSession, catalogUploadBodyLimit, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    try {
      const body = await context.req.parseBody();
      const upload = body.file;
      if (!(upload instanceof File)) return context.json({ error: "catalog_file_required" }, 400);
      const table = await parseUploadedCatalog(upload);
      if (table === undefined) return context.json({ error: "catalog_file_type_unsupported" }, 415);
      return context.json({ headers: table.headers, sampleRows: table.rows.slice(0, 5) });
    } catch (error) {
      if (isBodyLimitError(error)) throw error;
      if (error instanceof RangeError && error.message === "catalog_file_size_invalid") {
        return context.json({ error: error.message }, 400);
      }
      return context.json(validationResponse(error), 400);
    }
  });

  app.post("/catalog/imports/:importId/commit", tenantSession, async (context) => {
    const session = context.get("tenantSession");
    if (!mayWriteCatalog(session.role)) return context.json({ error: "catalog_write_denied" }, 403);
    if (!isUuidV7(context.req.param("importId"))) {
      return context.json({ error: "catalog_import_id_invalid" }, 400);
    }
    try {
      const committed = await dependencies.tenants.run(session.tenantId, async (database) => {
        const catalog = new TenantCatalogService(database, session.tenantId);
        return catalog.commitStagedImport(context.req.param("importId"));
      });
      return context.json({
        items: committed.map(serializeCatalogItem),
        committed: committed.length
      });
    } catch (error) {
      if (isUniqueViolation(error)) return context.json({ error: "catalog_sku_conflict" }, 409);
      if (error instanceof Error && error.message.includes("not found")) {
        return context.json({ error: "catalog_import_not_found" }, 404);
      }
      if (
        error instanceof Error &&
        /invalid|unclassified|incomplete|not staged/u.test(error.message)
      ) {
        return context.json({ error: "catalog_import_not_ready" }, 409);
      }
      throw error;
    }
  });

  app.put(
    "/catalog/imports/:importId/rows/:rowNumber/tax-class",
    tenantSession,
    async (context) => {
      const session = context.get("tenantSession");
      if (!mayWriteCatalog(session.role)) {
        return context.json({ error: "catalog_write_denied" }, 403);
      }
      const importId = context.req.param("importId");
      const rowNumber = Number(context.req.param("rowNumber"));
      if (!isUuidV7(importId) || !Number.isSafeInteger(rowNumber) || rowNumber <= 0) {
        return context.json({ error: "catalog_classification_target_invalid" }, 400);
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "catalog_classification_invalid" }, 400);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return context.json({ error: "catalog_classification_invalid" }, 400);
      }
      const taxClass: unknown = "taxClass" in body ? body.taxClass : undefined;
      const basisNote: unknown = "basisNote" in body ? body.basisNote : undefined;
      if (
        typeof taxClass !== "string" ||
        !taxClassSet.has(taxClass as TaxClass) ||
        !isValidClassificationBasis(basisNote)
      ) {
        return context.json({ error: "catalog_classification_invalid" }, 400);
      }
      try {
        const row = await dependencies.tenants.run(session.tenantId, async (database) => {
          const catalog = new TenantCatalogService(database, session.tenantId);
          return catalog.classifyStagedRow({
            importId,
            rowNumber,
            taxClass: taxClass as TaxClass,
            classifiedByUserId: session.userId,
            basisNote
          });
        });
        return context.json({
          row: { rowNumber: row.rowNumber, sku: row.sku, taxClass: row.taxClass }
        });
      } catch (error) {
        if (hasErrorCode(error, "P0002")) {
          return context.json({ error: "catalog_classification_target_not_found" }, 404);
        }
        if (hasErrorCode(error, "23514")) {
          return context.json({ error: "catalog_classification_conflict" }, 409);
        }
        throw error;
      }
    }
  );
}
