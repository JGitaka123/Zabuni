# Phase 0 implementation plan (F-1 through F-7)

**Status:** approved and implemented. The final decisions, deviations, verification evidence, and remaining gaps are recorded in `docs/reports/phase-0-completion.md`.

## 1. Scope and delivery rules

Phase 0 is foundation only:

- F-1: monorepo, strict TypeScript, CI, and empty service entry points.
- F-2: the approved Phase 0 database schema and forward-only migrations.
- F-3: database roles, RLS policies, tenant transaction context, and blocking cross-tenant tests.
- F-4: `Money`, Nairobi business-date helpers, and PII redaction.
- F-5: better-auth, phone-first OTP with email fallback, roles, tenant provisioning, and a bare authenticated shell that proves the verified session establishes database tenant context.
- F-6: generic durable outbox and drain worker with an offline flaky transport fixture.
- F-7: Sentry wiring, structured/redacted logs, and tenant-attributed usage/cost events demonstrated with a synthetic offline LLM event.

Explicitly excluded: quote/catalog workflows beyond the minimum `items.tax_class` schema requirement, eTIMS/Daraja/WhatsApp clients, RFQ ingestion, pricing, invoices, payments, agents, customer-facing UI, production deployment, and abstractions for countries other than Kenya. The external X-1 through X-4 workstreams remain owner-operated dependencies and are not performed by this code task.

Implementation will be one conventional commit per task (`F-1` through `F-7`), in order, after approval. Each task will use the PR description format in `AGENTS.md`. No remote push, PR, or Vercel deployment is part of Step 1.

## 2. Proposed repository layout

Only the following Phase 0 paths will be created. Later-phase package directories are deliberately omitted.

```text
.
├─ .github/
│  └─ workflows/ci.yml
├─ apps/
│  ├─ api/
│  │  ├─ src/{app.ts,index.ts,middleware/session.ts}
│  │  ├─ test/health.test.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ web/
│  │  ├─ app/{layout.tsx,page.tsx,sign-in/page.tsx,shell/page.tsx}
│  │  ├─ lib/{api.ts,auth-client.ts}
│  │  ├─ next.config.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ worker/
│     ├─ src/{index.ts,outbox/drain.ts,outbox/transport.ts}
│     ├─ test/outbox-drain.integration.test.ts
│     ├─ package.json
│     └─ tsconfig.json
├─ packages/
│  ├─ config/
│  │  ├─ eslint/base.mjs
│  │  ├─ typescript/{base.json,nextjs.json,node.json}
│  │  └─ package.json
│  ├─ core/
│  │  ├─ src/{money.ts,dates.ts,redact.ts,index.ts}
│  │  ├─ test/{money.test.ts,dates.test.ts,redact.test.ts}
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ db/
│  │  ├─ src/
│  │  │  ├─ schema/{auth.ts,tenancy.ts,items.ts,outbox.ts,usage-events.ts,index.ts}
│  │  │  ├─ migrations/
│  │  │  ├─ privileged/{claim-outbox.ts,test-seed.ts}
│  │  │  ├─ client.ts
│  │  │  ├─ tenant-context.ts
│  │  │  └─ index.ts
│  │  ├─ test/{rls.integration.test.ts,migrations.integration.test.ts,usage-events.integration.test.ts}
│  │  ├─ drizzle.config.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ auth/
│  │  ├─ src/{server.ts,session.ts,otp-transport.ts,fixture-otp-transport.ts,index.ts}
│  │  ├─ test/auth.integration.test.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ observability/
│     ├─ src/{logger.ts,sentry.ts,usage.ts,index.ts}
│     ├─ test/{logger.test.ts,usage.integration.test.ts}
│     ├─ package.json
│     └─ tsconfig.json
├─ test/
│  ├─ fixtures/
│  ├─ global-setup.ts
│  └─ network-guard.ts
├─ infra/local/
│  ├─ compose.yml
│  └─ postgres/init-roles.sql
├─ .env.example
├─ .gitignore
├─ eslint.config.mjs
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ prettier.config.mjs
├─ tsconfig.json
├─ turbo.json
└─ vitest.workspace.ts
```

Notes:

- `packages/db/src/privileged/` is intentionally explicit and tiny. Request-path code will never import it; lint/import-boundary tests will enforce that rule.
- The worker transport is an internal interface plus fixture, not an eTIMS, M-Pesa, WhatsApp, or Anthropic client.
- Redis/BullMQ wiring will be limited to an agreed worker bootstrap. Postgres remains the durable source of truth for outbox state.
- The web app is only an authentication/session proof shell. There is no design system or customer workflow in Phase 0.

## 3. Proposed pinned toolchain and libraries

These are conservative exact pins, not version ranges. They must be resolved into `pnpm-lock.yaml` and proven by the full clean-install gate before acceptance. Because this Step 1 must remain offline, the pins have not yet been registry-verified; approval includes permission to replace an unavailable pin with the nearest compatible patch and record that deviation before implementation.

Read-only environment check on 2026-08-05: the workstation currently has Node `24.18.0`, Corepack `0.35.0`, pnpm `9.15.9`, and Docker `29.5.3`. The proposed Node 22/pnpm 10 pins therefore require an explicit toolchain switch; alternatively, the project pins should be revised to the installed Node 24/pnpm 9 combination after compatibility validation. This is an approval decision, not a silent implementation substitution.

| Package                           | Version | Purpose / justification                                                               |
| --------------------------------- | ------: | ------------------------------------------------------------------------------------- |
| Node.js                           | 22.18.0 | LTS runtime with stable modern ESM support across the selected stack.                 |
| pnpm                              | 10.15.0 | Workspace package manager pinned through `packageManager` and Corepack.               |
| turbo                             |   2.5.6 | Small, established task graph/cache for the required monorepo.                        |
| typescript                        |   5.9.2 | Strict compiler baseline; no `any` without the documented exception.                  |
| next                              |  15.4.6 | App Router web shell without adopting an unvalidated major.                           |
| react / react-dom                 |  19.1.1 | Version matched to the selected Next.js line.                                         |
| hono                              |   4.9.2 | Lightweight typed HTTP layer required by the architecture.                            |
| `@hono/node-server`               |  1.19.1 | Explicit Node adapter for the separate API service.                                   |
| drizzle-orm                       |  0.44.5 | Typed Postgres schema/query layer and the ORM surface used by the RLS test.           |
| drizzle-kit                       |  0.31.4 | Forward-only SQL migration generation and validation.                                 |
| postgres                          |   3.4.7 | Small Postgres driver supported by Drizzle; transaction-local GUC support.            |
| better-auth                       |   1.3.7 | Required authentication framework with server-side session verification.              |
| bullmq                            |  5.58.5 | Required queue/worker library; durability remains in the Postgres outbox.             |
| ioredis                           |   5.7.0 | BullMQ-compatible Redis client, used only if the Redis question below is approved.    |
| pino                              |   9.9.0 | Structured JSON logging with a testable redaction boundary.                           |
| `@sentry/node` / `@sentry/nextjs` |  9.46.0 | Error capture for the worker/API and web surfaces, disabled when no DSN is present.   |
| zod                               |   4.1.5 | Runtime validation for environment, sessions, outbox envelopes, and usage events.     |
| uuid                              |  11.1.0 | Application-generated UUIDv7 without a database extension dependency.                 |
| vitest / `@vitest/coverage-v8`    |   3.2.4 | Unit/integration test runner and enforceable Money coverage thresholds.               |
| testcontainers                    |  11.5.1 | Real Postgres integration tests when Docker is available; never SQLite/mocks for RLS. |
| eslint                            |  9.34.0 | Flat-config linting and import-boundary enforcement.                                  |
| typescript-eslint                 |  8.41.0 | Type-aware lint rules for strict TypeScript.                                          |
| prettier                          |   3.6.2 | Deterministic formatting with no runtime effect.                                      |
| tsx                               |  4.20.5 | Runs TypeScript migration/worker utilities without a bespoke build runner.            |

No external-integration SDK is added in Phase 0. Date handling will initially use `Intl` plus explicit `Africa/Nairobi` helpers rather than introduce a second date abstraction; this remains subject to the business-day question below.

## 4. Task-by-task implementation

### F-1 — scaffold, strict TypeScript, CI

1. Add root workspace/task configuration and package-level build/test/typecheck/lint scripts.
2. Add minimal compiling API, web, and worker entry points and shared configuration packages.
3. Default `INTEGRATION_MODE=fixture`; install a test network guard that fails unexpected socket/HTTP calls.
4. Add local Postgres/Redis containers only as approved below; pin image digests during implementation.
5. Add CI with the global required order: frozen install, typecheck, lint, test, build. RLS tests use real Postgres and the exact runtime role.
6. Update README local setup only after following it from a clean checkout/worktree.

### F-2 — database and approved core schema

Implement only the schema approved in the questions below. The recommended Phase 0 minimum is tenants, domain users/membership and required auth tables, items (including the legally required tax check), usage events, outbox, and any approved incident table. Future quote/payment/agent tables remain in their owning phases.

All identifiers are application-generated UUIDv7. All monetary columns use `bigint`; currency is an explicit ISO-4217 `char(3)` wherever a value does not have an approved same-row aggregate currency invariant. Timestamps are `timestamptz` in UTC. Foreign keys and unique constraints are tenant-safe.

### F-3 — RLS and tenant isolation

Provision separate roles outside ordinary Drizzle migrations:

- schema owner: `NOLOGIN`, owns objects;
- migrator: login used only by migration tooling, able to assume the owner role;
- application runtime: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`, owns no tables;
- any narrowly scoped auth/worker role must be explicitly approved and must not become a generic service-role request connection.

Revoke default `PUBLIC` privileges. Every tenant-owned table gets `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and explicit grants. To prevent a later permissive policy from widening access through PostgreSQL's OR composition, use a restrictive `tenant_boundary` policy with both `USING` and `WITH CHECK`, plus a narrowly scoped permissive access policy for the runtime role. The boundary predicate uses a null-safe, `SECURITY INVOKER`, stable helper over `current_setting('app.tenant_id', true)` and fails closed when no context is present. For `tenants`, it compares `id`; other approved tenant tables compare their non-null `tenant_id`. A policy-shape regression test rejects an unreviewed runtime policy.

The only normal database entry point for tenant work will be `withTenant(verifiedTenantId, callback)`. It starts a transaction, parameterizes `set_config('app.tenant_id', tenantId, true)`, verifies the value, and exposes only the transaction-scoped Drizzle handle. The tenant ID comes from a verified session/membership, never a request header or body. Transaction-local context prevents pooled-connection leakage.

The blocking RLS test uses real Postgres and Drizzle as the exact non-owner runtime role. Privileged setup creates tenants A and B and representative rows for **every** tenant-owned table. A table-driven matrix proves:

- A can read only A, including when querying explicitly for B's known ID; B mirrors this.
- cross-tenant insert and tenant-changing update fail with RLS errors;
- cross-tenant update/delete affect zero rows;
- cross-tenant parent/child references are rejected;
- missing context reads nothing and cannot write;
- context does not leak after commit, rollback, pool reuse, or concurrent A/B transactions.

Metadata assertions prove each registered tenant table has RLS and FORCE RLS, a policy with `USING` and `WITH CHECK`, correct grants, a non-owner runtime, and `rolbypassrls=false`. A schema registry makes adding a tenant table without adding it to this matrix a failing test.

### F-4 — core correctness utilities

`Money` is immutable and never converts the minor-unit value to `number`. Its public representation is `bigint` plus validated ISO-4217 currency. Tests cover construction/serialization, currency mismatch, addition/subtraction, percentage application, allocation with deterministic remainder distribution, rounding, invalid inputs, zero/negative boundaries once clarified, and very large values. Coverage thresholds for `money.ts` are 100% statements, branches, functions, and lines.

Date helpers accept/return explicit instants or plain business dates, calculate using `Africa/Nairobi`, and store instants as UTC. Redaction is centralized at the logger boundary and unit-tested for the approved PII patterns; phone numbers, KRA PINs, OTPs, and message bodies never appear in plaintext logs.

### F-5 — authentication and bare shell

Use better-auth with its Postgres adapter, a fixture OTP delivery transport by default, secure cookie/session settings, and the approved tenant membership model. Tenant creation and first owner membership occur atomically. API middleware verifies the session, derives the tenant from server-trusted membership, then uses `withTenant` for every database transaction. The sole authenticated page displays non-sensitive session/tenant proof returned by the API; it contains no business feature.

Integration tests cover sign-up, tenant provisioning, OTP expiry/replay/rate-limit behavior once specified, email fallback, role assignment, invalid/expired sessions, suspended tenant behavior once specified, and confirmation that a session for tenant A cannot cause any tenant B query.

### F-6 — durable outbox

The generic outbox is written atomically with domain state. Rows have an immutable, versioned payload envelope; tenant ID; globally or tenant-scoped unique idempotency key as approved; state; attempt/max-attempt counters; next-attempt time; lease/claim metadata; redacted error summary; result reference; and audit timestamps. Claiming uses a short transaction and `FOR UPDATE SKIP LOCKED` or an equally safe approved function. Calls occur outside the claim transaction; acknowledgement/failure transitions are separate tenant-scoped transactions. Expired leases are recoverable.

The worker provides at-least-once delivery attempts and relies on a transport's idempotency-key contract for exactly-once external effect. An offline flaky fixture simulates transient failure, permanent failure, duplicate delivery, concurrency, and a crash after external success but before local acknowledgement. Fake time advances exponential backoff. Assertions prove one external effect, eventual terminal state (`sent`, `failed_permanent`, or `cancelled`), correct attempt accounting, recoverable leases, and no stuck rows. Permanent failure persists an approved incident/event; no customer-facing incident UI is built.

Cross-tenant claiming is implemented only through an explicit, audited `packages/db/src/privileged/` boundary with fixed `search_path` and least privilege. Claimed work is processed inside a fresh normal `withTenant` transaction. Request-path packages cannot import the privileged module.

### F-7 — observability and tenant cost metering

Pino emits structured JSON with request/job/correlation IDs and mandatory redaction. Betterstack is a deployment sink, not a network dependency in local/test. Sentry initializes only when configured, uses a no-op/test transport offline, and passes events through the same PII scrubber.

`usage_events` is append-only and tenant-scoped. A typed metering service records metric, integer quantity, event time, unit cost in minor units plus currency (subject to approval), and allow-listed metadata. A synthetic fixture LLM operation writes one event end to end without calling Anthropic. Tests prove attribution, integer cost arithmetic, RLS isolation, retry/deduplication behavior once specified, and absence of PII.

## 5. Migration and bootstrap order

Migrations are forward-only and never edited after shipment. Role/database bootstrap is separate because runtime roles must not own migrated objects.

1. `bootstrap/001_roles.sql`: roles, ownership model, revoked public privileges, and default privileges (local/CI equivalent of platform provisioning).
2. `0000_foundation.sql`: application schema, required enum/domain types, and null-safe current-tenant helper. Do not add pgvector until Q-3 unless full schema is explicitly approved.
3. `0001_tenancy.sql`: tenants, users/memberships, and the minimal approved authentication primitives.
4. `0002_items.sql`: catalog item base with `tax_class NOT NULL`, no default, and an explicit `CHECK` for `standard_16`, `zero_rated`, or `exempt`.
5. `0003_usage_events.sql`: tenant-attributed append-only metering table and indexes. Its task/commit placement depends on the F-2/F-7 ownership answer.
6. `0004_outbox.sql`: outbox, indexes, state constraints, and any approved incident table. Its task/commit placement depends on the F-2/F-6 ownership answer.
7. `0005_rls.sql`: enable/force RLS, policies, grants, and tenant-safe composite constraints for all preceding tenant tables.
8. Later F-5/F-6/F-7 migrations: better-auth generated changes, privileged outbox claim function, or observability/metering additions only when their owning task is reached.

Migration tests start from an empty database, apply the sequence with the migrator, validate schema/constraints/policies as the runtime role, and prove that repeated deployment detects rather than edits prior migrations. “Backward-compatible” will mean expand/contract compatibility with the prior application release, not down migrations, if approved below.

## 6. Verification strategy

Every task must leave all applicable gates green. The final Phase 0 verification is:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Additional blocking checks:

- zero unapproved network calls in tests; all integration mode defaults to `fixture`;
- real Postgres migration and complete ORM RLS matrix;
- 100% statements/branches/functions/lines for `money.ts`;
- flaky outbox/crash/concurrency/idempotency test;
- synthetic tenant cost event end to end;
- bare auth session to tenant transaction proof;
- build output contains no secrets and logs/Sentry events contain no prohibited PII;
- README setup followed from a clean isolated checkout with exact commands/results recorded.

## 7. Ambiguities and contradictions requiring answers

No implementation choice will be made for these without approval.

### Repository and delivery

1. The specs and README links expect `docs/*.md`, but all specification files are currently at the repository root. Should the specs be moved into `docs/`, should references be updated to root paths, or should only `docs/plans/phase-0.md` be added for now?
2. This folder's authoritative Git top level is `C:/Users/user` (`.git` resolves to `../../../.git`), whose `origin` points to `JGitaka123/Aifya2.0-newborn`, not `JGitaka123/Zabuni`; the current branch is `main` despite the instruction to work on a feature branch. Should this folder be re-initialized/re-cloned as its own Zabuni repository before F-1?
3. Is the CI provider GitHub Actions? Does “no network” mean no runtime/test calls to external services, or literally no package/image download? A clean `pnpm install` cannot run literally offline without a pre-populated store or vendored dependencies.
4. Architecture says CI uses an ephemeral Neon branch, which requires network, while the task requires offline verification. May CI use an ephemeral local Postgres service instead?
5. The broad request mentions Vercel for the frontend, but Phase 0 has no deployment task and Step 1 forbids implementation. Should Vercel configuration wait for a later deployment task, or is a preview deployment a separately approved Phase 0 acceptance criterion? The architecture supports putting only `apps/web` on Vercel; where will the separately deployed, always-on Hono API and BullMQ worker run, and which regions/data-transfer basis are approved?
6. X-1 through X-4 start on day one but require owner/legal/portal actions. Who owns them, and should repository tracking issues/checklists be added in a separate task?

### Phase/task ownership

7. Does F-2 “core schema from docs/03” mean every table in the full multi-phase model, or only tables required by Phase 0? The former builds ahead of the plan and forces RLS tests for future tables; this plan recommends the Phase 0 minimum.
8. `usage_events` belongs to the documented data model/F-2, but metering is F-7; outbox is architecturally core/F-2, but implementation is F-6; auth tables are core/F-2, but auth is F-5. Which task owns each table/migration so one commit per task remains true?
9. The attached brief says cost metering exists “from the first commit,” while the build plan assigns it to F-7. Which ordering is authoritative?
10. Does “migrations apply forward and backward-compatibly” mean rolling application compatibility (recommended), or are down migrations expected despite the explicit forward-only rule?
11. Architecture requires tenant-visible incidents on permanent outbox failure, but no incident schema exists and Phase 0 forbids customer-facing UI. Is persisting an incident/event sufficient in F-6 with UI deferred?

### Database and RLS

12. Which exact tables are tenant-owned? `tenants` has no `tenant_id`; several child tables (`item_embeddings`, `rfq_lines`, `quote_lines`, `payment_allocations`) omit it despite the rule that every tenant table carries it. Should every child receive a redundant non-null `tenant_id` plus composite tenant FK (security recommendation), or use parent-join RLS policies?
13. May Phase 0 enforce `FORCE ROW LEVEL SECURITY` in addition to enabling it? Is a fail-closed missing context expected to return zero rows or raise an error?
14. Can target Neon credentials provision separate owner/migrator/runtime roles and default privileges, or must platform provisioning use a different role design?
15. How should better-auth discover and verify a session before tenant RLS is established? Should auth tables use a narrowly scoped non-tenant auth role, while all domain queries use the normal tenant role?
16. A worker bound by tenant RLS cannot discover pending work across tenants. With `FORCE RLS`, even a table-owner `SECURITY DEFINER` function remains subject to RLS; cross-tenant claiming therefore needs either an explicitly approved, non-login, narrowly scoped `BYPASSRLS` function owner or a redesigned per-tenant dispatcher. Which model is approved? In either case, may claimed work then run through normal per-tenant processing?
17. Are tenant users single-tenant, or can one human belong to multiple tenants? The data model puts `tenant_id` directly on `users`, while common auth models separate users from memberships.
18. What is the UUIDv7 source of truth: application generation (proposed) or a required Postgres extension?
19. Should pgvector and `item_embeddings` be installed in F-2, or deferred to Q-3 to avoid building ahead?
20. `delivery_zone_id` and price-rule `category` reference models that are not defined. Are those tables intentionally deferred, or missing from F-2?
21. Architecture requires append-only audit logs for invoice, price, and policy changes, but no audit schema/task exists. Is audit infrastructure part of Phase 0 or a later owning phase?

### Tax and money — do not infer

22. `items.tax_class` must be `NOT NULL` with no default, but docs also say an item “without one” blocks invoicing and Q-2 introduces classification. Must item creation/import be blocked until classification, use a separate staging table, or is an explicit unclassified state intended? The latter conflicts with the required three-value check.
23. Numerous `_minor` columns do not have their own currency column (`credit_limit_minor`, rule/line/note/allocation values, agent costs/outcomes, and `usage_events.unit_cost_minor`). Must each receive a currency column, or may currency inherit from a parent/tenant under an explicit invariant?
24. What input represents a percentage in `Money` (basis points is proposed), and what rounding mode is legally/product-correct (half-up, half-even, toward zero, or another rule)?
25. For allocation/splitting, are inputs equal parts or weighted ratios; how is the remainder ordered; and what are the required behaviors for negative amounts, negative/zero weights, and more parts than minor units?
26. Must `Money` support currencies with non-two minor-unit scales even though Phase 0 is Kenya/KES, or only validate the ISO code while storing caller-supplied minor units?

### Auth, dates, redaction, and operations

27. Which SMS and email providers will eventually deliver OTPs, and what exact fixture behavior is required now? Specify OTP length, expiry, resend/rate limits, replay prevention, account enumeration behavior, and email fallback trigger.
28. What does “roles” require in F-5 beyond storing `owner | manager | sales | finance | readonly`? Which Phase 0 endpoint/page permissions must be demonstrated?
29. What makes a session “verified,” how is tenant creation joined atomically to first-owner creation, and what should happen when a tenant is suspended?
30. Does “business day” mean Monday–Friday only or must Kenyan public holidays be included? Which operations and boundary cases must the date helpers expose?
31. Define the required redaction contract: exact KRA PIN/phone/OTP/message-body patterns, replacement format, structured-key policy, and handling of false positives.
32. Outbox schema and behavior are not specified: payload/version, idempotency uniqueness scope, retryable/permanent taxonomy, maximum attempts, backoff base/multiplier/jitter/cap, lease timeout, ordering, retention, cancellation permissions, and result/error fields all need approval.
33. Exactly-once external effect is impossible generically without destination idempotency across a crash boundary. Is the proposed contract—at-least-once attempts plus mandatory idempotency keys and idempotent transports—the intended acceptance criterion?
34. Architecture mandates BullMQ/Redis but also emphasizes one database/no second datastore. Is Redis approved as non-authoritative queue infrastructure in Phase 0, and does it trigger outbox drains or should the worker poll Postgres directly?
35. F-7 says an “LLM call” appears in usage events, while the brief asks for a synthetic event and Phase 0 excludes Anthropic integration. Is an offline synthetic metered LLM fixture sufficient?
36. What are the `usage_events` idempotency/deduplication rules, token quantity units, cost currency, pricing snapshot metadata, and treatment of failed/retried calls?
37. Should Betterstack/Sentry be fully configured but no-op locally when credentials are absent, with test transports proving payloads without network (recommended)?
38. For Vercel previews, what API origin, credentialed CORS allow-list, cookie domain/SameSite policy, and isolated non-production database are required? Preview builds must never point at production data or run migrations during the Vercel build.
39. The local workstation provides Node 24.18.0 and pnpm 9.15.9, while the proposed conservative pins are Node 22.18.0 and pnpm 10.15.0. Should implementation switch to the proposed LTS toolchain, or align the repository pins to the installed toolchain after dependency compatibility checks?

## 8. Approval gate

Please review this plan and answer or explicitly defer the numbered questions. Implementation will begin with F-1 only after approval, and will not proceed past any unresolved question that affects that task's behavior, security, tax treatment, money handling, customer communication, or acceptance criteria.
