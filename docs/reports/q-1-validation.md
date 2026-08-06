# Q-1 catalog and import validation

**Repository:** `JGitaka123/Zabuni`

**Branch:** `codex/q-1-catalog-import`

**Review date:** 2026-08-06

## Assessment

The Q-1 implementation is complete and passes synthetic/offline verification. It is not formally accepted because the repository does not contain Safuney's real SKU workbook or an approved shape-equivalent sanitized copy. The Phase 1 plan defines a clean import of that workbook as the Q-1 completion gate.

## Delivered

- Tenant-scoped catalog list, create, update, and archive services and authenticated HTTP routes.
- Explicit CSV/XLSX column inspection, mapping, validation, durable staging, and atomic insert-only commit.
- Explicit tax handling: missing tax stays in staging; invalid or unclassified rows cannot reach `items`.
- Base-10 minor-unit strings at file/JSON boundaries and PostgreSQL `bigint` persistence.
- Forced-RLS import audit tables, cross-tenant tests, immutable committed batches, and case-insensitive tenant/SKU uniqueness.
- Resource limits for file size, XLSX archive expansion, rows, columns, and cell length; formulas and dates are rejected.
- A catalog screen that exposes row number, SKU, field, and message for import problems.

## Verification evidence

- Frozen dependency installation passes offline.
- Catalog tests cover CSV/XLSX parsing, mapping, explicit tax, money validation, staging, CRUD, archive, tenant isolation, case-folded duplicates, and concurrent commit serialization.
- Database tests cover all tenant-owned tables, import audit immutability, RLS, grants, and forward migrations.
- API tests cover role denial, validation, file type rejection, wrapped uniqueness conflicts, and malformed identifiers.
- Repository-wide typecheck passed (13/13 dependency-aware tasks).
- Repository-wide lint passed (8/8 workspaces).
- Repository-wide tests passed (22 files, 111 tests, including real PostgreSQL RLS and catalog integration checks).
- Repository-wide build passed (8/8 workspaces; the catalog route was generated as a static Next.js page).

## Acceptance work still required

1. Provide a permitted Safuney workbook locally (do not commit customer data).
2. Record its SHA-256 checksum, file type, row/column counts, explicit mapping, and validation counts.
3. Resolve any real-file shape differences without guessing tax meaning or monetary units.
4. Confirm zero rejected/unclassified rows, commit into an ephemeral tenant, and reconcile imported counts and representative SKUs with Safuney.

Until those steps pass, Q-2 and later tasks remain gated by `docs/08-build-plan.md`.
