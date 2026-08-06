# Q-2 validation report

**Task:** Q-2 — Tax classification workflow, blocking on unclassified

**Status:** implemented and verified on 2026-08-06

**Branch:** `codex/q-2-tax-classification`

## Outcome

Zabuni now requires an owner or manager to make an explicit KRA tax-class decision before a catalog item can be created or a staged import row can be committed. The decision includes a required internal basis note and creates append-only, tenant-isolated evidence. No tax class is defaulted, suggested, or silently inferred.

## What changed

- Added a forced-RLS `catalog_tax_classifications` audit table with actor, source, basis, timestamp, and item/import provenance.
- Added explicit audited database functions for item creation/reclassification and staged-row classification.
- Revoked direct application-role paths that could change tax classification without evidence.
- Added deferred database enforcement so catalog items and committed imports cannot exist without matching evidence.
- Added a deployment preflight migration that rejects legacy gaps instead of inventing audit history.
- Added owner/manager API and catalog UI workflows for creation, reclassification, and staged-import classification.
- Preserved the original classifier and import-row provenance when classified rows become catalog items.

## Verification

All required repository gates passed:

- `pnpm install --frozen-lockfile` — lockfile current; 9 workspace projects ready.
- `pnpm typecheck` — 13/13 tasks passed.
- `pnpm lint` — 8/8 tasks passed.
- `pnpm test` — 22 test files and 120 tests passed.
- `pnpm build` — 8/8 production builds passed; the web application compiled and all seven static pages generated.
- `git diff --check` — passed.

The test suite includes 30 database tests, 26 catalog tests, and 12 catalog API tests. Coverage added for tenant isolation, append-only evidence, denied direct mutation, commit readiness, exact tax values, role restrictions, malformed requests, concurrent classification, and provenance retention.

## Expert review

The specification and implementation were reviewed independently. The final review found no remaining Q-2 merge blockers after the database privilege boundary, legacy-data preflight, concurrency handling, and provenance checks were hardened.

## Spec deviation and forward dependency

The repository does not yet contain quote, order, invoice, or invoice-line tables. Adding placeholder invoice tables in Q-2 would violate the build order. Q-2 therefore enforces the invariant at the catalog boundary: only explicitly classified items can exist or be committed.

When invoiceable lines are introduced in Q-7/E-3, that task must add the corresponding database constraint and store an immutable per-line tax snapshot plus item/service provenance. Resolving tax from the item's current value at transmission time would make historical invoices incorrect after reclassification.

## Known non-blocking issue

The Next.js build reports that its optional ESLint plugin is not detected in the shared ESLint configuration. Compilation, type checking, repository linting, and static generation still pass. This is tooling configuration debt, not a Q-2 functional defect.

## Deployment

No Vercel deployment was performed. Q-2 is an internal catalog workflow, and deployment credentials or an approved production target were not part of this phase. The frontend production build is Vercel-compatible and passed locally.
