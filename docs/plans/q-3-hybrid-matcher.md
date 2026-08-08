# Q-3 hybrid catalog matcher

**Status:** engineering complete; formal product acceptance pending external inputs.

## Scope

Q-3 adds tenant-isolated pgvector item embeddings, a learned alias table, and an explainable hybrid matcher over catalog items. It includes a deterministic fixture embedding transport and a reproducible evaluation harness. It does not add RFQ ingestion, extraction, pricing, quote construction, or an LLM reranker from later tasks.

## Decisions

- Matching is deterministic vector plus lexical ranking. Haiku reranking is deferred because the architecture does not define its schema, prompt, threshold, or failure behavior for this task.
- The embedding boundary requires 1,024 finite dimensions and records provider, model, version, normalized text, and a content hash. Incompatible or stale embeddings are excluded rather than compared silently.
- Offline development uses a deterministic fixture embedding transport. It proves plumbing and ranking behavior but is not represented as a production semantic model.
- Matching falls back to lexical and alias evidence when a compatible embedding is unavailable and marks the result as degraded.
- Exact aliases are a strong signal, not an unconditional override when pack-size or unit evidence conflicts.
- Owner, manager, and sales roles may record a correction. Direct alias administration is owner/manager only. Alias reassignment must be explicit.
- Alias hit count changes only when a user confirms use, never when the matcher merely retrieves or ranks it.
- Ranking ties resolve by normalized SKU and then item ID so results are repeatable.

## Database invariants

- `item_embeddings` and `item_aliases` carry non-null `tenant_id`, composite tenant/item foreign keys, forced RLS, and restrictive tenant boundaries.
- There is one current embedding per item. Its dimension is exactly 1,024 and its content hash identifies the normalized item text it represents.
- Alias text is nonblank and unique per tenant under case-folding. Sources are only `human` and `accepted_match`; hit counts cannot be negative.
- Inactive items are never returned by the matcher.
- Cross-tenant references and reads fail at the database boundary as well as in application queries.

## Matcher and lifecycle

1. Build normalized item text from SKU, description, brand, pack size, and unit of measure.
2. Generate or accept an embedding through the typed provider boundary and upsert it idempotently.
3. Retrieve compatible vector candidates and tenant aliases, then calculate vector, token, alias, pack-size, and unit components.
4. Return deterministic candidates with component scores, final score, method, and degradation reasons.
5. Record explicit human corrections as learned aliases; never self-train from an unconfirmed top result.

Catalog creation/import integration will expose explicit embedding refresh methods rather than hiding network work inside catalog transactions. Future workers can call the same idempotent method when Q-4/Q-5 introduce ingest jobs.

Candidate retrieval is bounded per request. Exact tenant aliases and lexical candidates are combined with compatible vector candidates; final vector distance ordering is exact within the tenant-filtered query so a global approximate index cannot discard a small tenant's nearest items. API requests are capped by body size and result count. Database-shared per-user and per-tenant windows, cross-instance concurrency locks, and a short statement timeout bound request pressure.

## Verification

- Migration metadata, extension preflight, vector dimension, HNSW cosine index, constraints, grants, and RLS tests.
- Unit tests for normalization, deterministic fixture embeddings, score composition, pack/unit conflicts, aliases, tie-breaking, invalid input, stale/missing vectors, and inactive items.
- Integration tests for tenant isolation, cross-tenant foreign keys, alias uniqueness, idempotent embedding refresh, corrections, reassignment conflicts, and confirmed alias usage.
- API tests for matching, correction/admin roles, validation, and tenant boundaries.
- Offline evaluation tests with a frozen synthetic fixture and checksums.
- Full repository install, typecheck, lint, test, and build gates.

## External acceptance gates

The repository contains neither Safuney's held-out RFQ set nor an approved catalog snapshot, so the build-plan top-1 >=80% result cannot yet be measured. The production embedding provider/model is also unspecified. Q-3 engineering is verified offline, but formal product acceptance requires both artifacts and must use a held-out set that was not used to tune normalization, weights, aliases, or fixture vectors.
