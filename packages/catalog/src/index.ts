export { parseCsv, parseXlsx } from "./parse.js";
export {
  buildItemSearchText,
  EMBEDDING_DIMENSIONS,
  embeddingContentHash,
  FixtureEmbeddingProvider,
  MAX_MATCH_TEXT_LENGTH,
  normalizeMatchText,
  validateEmbedding,
  type EmbeddingDescriptor,
  type EmbeddingProvider,
  type SearchableItemText
} from "./embedding.js";
export {
  evaluateTopOne,
  type MatchEvaluationCase,
  type MatchEvaluationFailure,
  type MatchEvaluationReport
} from "./evaluation.js";
export {
  MATCHER_VERSION,
  TenantCatalogMatcher,
  type AliasRecord,
  type CatalogMatchCandidate,
  type CatalogMatchResult,
  type MatchScore
} from "./matching.js";
export {
  acquireCatalogMatchConcurrency,
  CatalogRateLimitError,
  consumeCatalogRequestRate,
  type CatalogBudgetOperation
} from "./rate-limit.js";
export {
  TenantCatalogService,
  serializeCatalogItem,
  type CatalogImport,
  type CatalogItem,
  type SerializedCatalogItem
} from "./service.js";
export {
  CatalogMappingError,
  CatalogValidationError,
  previewImport,
  validateCatalogInput
} from "./validate.js";
export {
  catalogFields,
  type CatalogField,
  type CatalogInput,
  type ColumnMapping,
  type ImportIssue,
  type ImportPreview,
  type ImportRow,
  type ParsedTable,
  type RejectedImportRow,
  type StagedImportRow,
  type TaxClass,
  type ValidatedImportRow
} from "./types.js";
