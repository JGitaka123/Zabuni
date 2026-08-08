# Q-3 validation report

**Task:** Q-3 - pgvector embeddings, hybrid matcher, and alias table

**Status:** engineering complete and verified on 2026-08-07; formal acceptance blocked by missing external evidence

**Branch:** `codex/q-3-hybrid-matcher`

## Outcome

Zabuni now has a tenant-isolated, explainable catalog matcher that combines compatible 1,024-dimension vectors with lexical, learned-alias, pack-size, and unit evidence. Human corrections are explicit and auditable; the matcher does not silently self-train. Offline development and CI use deterministic fixture embeddings and never contact an external model provider.

The code is ready for review and integration. Q-3 is not formally accepted because the build plan requires top-1 accuracy of at least 80% on Safuney's held-out RFQ set, and neither that dataset nor an approved Safuney catalog snapshot exists in this repository. A production embedding provider, model, and version are also not specified.

## What changed

- Added forward-only pgvector provisioning and migration `0016_catalog_matching.sql` with forced-RLS `item_embeddings` and `item_aliases` tables, composite tenant foreign keys, constraints, metadata, and indexes.
- Added a strict embedding boundary with dimensionality and finite-number validation, normalized content hashing, staleness detection, and a deterministic offline fixture provider.
- Added bounded hybrid retrieval and deterministic scoring with component-level explanations, inactive-item exclusion, exact tenant-filtered vector ordering, and degraded lexical fallback.
- Added explicit alias administration and confirmation workflows with role checks, atomic first-use behavior, controlled reassignment, case-insensitive uniqueness, and usage counting.
- Added authenticated API routes with 4 KiB body limits, result caps, input validation, database-shared per-user/per-tenant rate controls, cross-instance concurrency limits, and bounded pagination.
- Moved rate-counter mutation behind a tenant-validating, fixed-search-path database function and revoked direct application inserts and updates.
- Added a reproducible fixture evaluation CLI that refreshes current vectors, records dataset/catalog checksums, and fails below 80%; it is intentionally not evidence of Safuney acceptance.
- Updated local and CI PostgreSQL provisioning to include pgvector and updated Turbo environment forwarding so integration database overrides reach every workspace package.

## Verification

All required repository gates passed offline:

- `pnpm install --frozen-lockfile --offline` - lockfile current; all 9 workspace projects ready.
- `pnpm typecheck` - 13/13 tasks passed.
- `pnpm lint` - 8/8 tasks passed.
- `pnpm test` - 145 tests passed across all 8 packages.
- `pnpm build` - 8/8 production builds passed; the Next.js application compiled and generated all 7 static pages.
- `git diff --check` - passed.

The test suite includes 35 database tests, 38 catalog tests, and 20 API tests. Q-3 coverage exercises embedding validation and idempotency, stale/incompatible vectors, inactive items, deterministic ties, alias learning/reassignment/concurrency and quota boundaries, shared rate windows and concurrency slots, privileged counter mutation, tenant isolation, forced RLS, cross-tenant references, role enforcement, malformed input, and provider-unavailable behavior.

Local database verification used an isolated disposable PostgreSQL 16 container with pgvector 0.7.4 because the official committed image was not present in the offline cache. The committed local/CI configuration uses `pgvector/pgvector:0.8.1-pg16` and still needs the approved registry digest recorded before a production deployment.

## Expert review

Independent correctness and security reviewers audited the final diff. Their earlier findings drove evaluator vector preparation, serialized alias learning, atomic database quota enforcement, bounded candidate retrieval, shared user/tenant rate windows, user and tenant concurrency slots, statement timeouts, and explicit tie/pack/unit coverage. Both final reviews found no remaining code merge blocker. They agreed that the real Safuney evaluation, production embedding decision, and pgvector image digest remain external acceptance or deployment gates.

## Safety and operational posture

- Runtime matching never calls a live provider while holding a database transaction. The API accepts only the fixture provider for request-path embedding; live/sandbox operation falls back explicitly until a background embedding worker is designed.
- Vector candidates are filtered by tenant and descriptor, while stale or incompatible vectors are excluded. Forced RLS remains the database backstop.
- Work per request is bounded: 1,000-character match text, 25 returned matches, 100 vector candidates, 250 lexical candidates, 10,000 tenant aliases, paginated alias reads, 4 KiB JSON bodies, 30 match requests per user/minute, 300 per tenant/minute, 2 concurrent matches per user, 4 concurrent matches per tenant across instances, and a 2-second database statement timeout.
- Alias writes have separate database-shared user and tenant windows. A database-maintained quota counter atomically enforces the 10,000-alias tenant cap even when writes race.

## Formal acceptance blockers

1. Provide a permitted, frozen Safuney catalog snapshot and genuinely held-out RFQ-to-SKU labels.
2. Select and document the production embedding provider/model/version that produces exactly 1,024 dimensions, including privacy, residency, cost, retry, and retention decisions.
3. Generate production vectors outside request transactions, run the frozen evaluation without tuning on the held-out set, and attach the signed/checksummed report proving top-1 accuracy >=80%.
4. Record an immutable digest and provenance policy for the official pgvector container before production deployment.

Until items 1-3 are complete, the repository's order-of-work rule prevents Q-4 from starting. The fixture evaluation proves engineering behavior only and must not be presented as the product metric.

## Spec deviations and deliberate deferrals

- No LLM reranker was added. Q-3 defines hybrid matching but does not specify a reranker prompt, schema, model, threshold, or failure policy; adding one would create an unapproved external dependency.
- Production embedding generation is deferred to a worker boundary because the provider is unspecified and network work must not occur inside catalog transactions.
- No Vercel deployment was performed. Q-3 changes backend/catalog infrastructure and adds no frontend feature requiring deployment. The existing frontend production build remains green and Vercel-compatible.

## Known non-blocking issues

- The database application role still has direct RLS-protected mutation grants on item aliases and embeddings. A future hardening task can replace those writes with narrow fixed-search-path security-definer functions, but forced RLS, typed request paths, composite tenant keys, and the protected alias-quota trigger currently enforce the operative boundaries.
- The HNSW index is global. Exact tenant-filtered ordering protects correctness today, but larger multi-tenant scale should use partitioning or another tenant-aware ANN strategy before approximate search is enabled.
- The Next.js build reports that its optional ESLint plugin is not detected in the shared ESLint configuration. Compilation, strict type checking, repository linting, and static generation still pass.
