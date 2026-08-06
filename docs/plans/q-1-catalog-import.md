# Q-1 catalog and import plan

**Status:** implementation and offline verification complete; Safuney acceptance data pending.

## Scope

Q-1 delivers tenant-scoped catalog CRUD plus mapped CSV/XLSX import. It does not implement tax classification, embeddings, aliases, price rules, RFQ intake, R2 storage, stock, substitutes, or quote UI.

## Safety decisions

- `items.tax_class` remains `NOT NULL`, has no default, and accepts only `standard_16`, `zero_rated`, or `exempt`.
- Import rows without an explicit valid tax class may be stored only in tenant-isolated staging. They never become sellable `items` and no class is inferred.
- Import commit is insert-only. A duplicate SKU is a row error; imports never overwrite cost or tax data implicitly.
- Monetary input crosses JSON/file boundaries as base-10 minor-unit strings and becomes `bigint` before persistence. Floating-point currency parsing is forbidden.
- Catalog deletion is archival (`active = false`) so later quote/invoice audit references remain intact.
- Only server-verified tenant context reaches catalog services; request bodies cannot choose a tenant.

## Delivery shape

1. Add forward-only tenant-owned import batch/row tables, forced RLS, grants, and blocking cross-tenant tests.
2. Add `packages/catalog` with CSV/XLSX parsing, explicit column mapping, validation, preview, staged import, and catalog CRUD services.
3. Add thin authenticated API routes for item list/create/update/archive and import preview/commit.
4. Add a minimal dense catalog/import screen only if needed to exercise row errors; Q-7 remains the quote-builder UI task.
5. Verify frozen install, typecheck, lint, tests, and build offline.
6. Run the real or approved sanitized Safuney workbook locally, record its checksum/shape/result counts without committing sensitive contents, then complete Q-1.

## Literal acceptance blocker

The repository contains no Safuney SKU workbook. Synthetic fixtures can prove parser and database behavior, but Q-1 cannot honestly be marked complete until a permitted real or shape-equivalent sanitized workbook imports cleanly.
