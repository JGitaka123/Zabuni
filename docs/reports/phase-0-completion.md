# Phase 0 completion report

**Repository:** `JGitaka123/Zabuni`

**Branch:** `codex/phase-0`

**Review date:** 2026-08-05

**Scope:** F-1 through F-7 only

## Executive assessment

Phase 0 is implemented and its required local gates pass. The result is a strict TypeScript monorepo with a real PostgreSQL tenant boundary, a phone-first authentication foundation, durable outbox delivery, privacy-safe observability, and tenant-attributed LLM cost metering. Nothing from the quote, invoicing, payments, WhatsApp, or agent phases was built ahead of schedule.

The foundation is suitable for beginning Phase 1 engineering after the owner decisions and external workstreams in the gap register are acknowledged. It is not yet a production launch: Phase 0 intentionally has no customer workflow, live integration credentials, production infrastructure, or completed compliance/certification work.

## Delivered scope

| Task | Outcome                                                                                                                                          | Acceptance evidence                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1  | pnpm/Turborepo monorepo, strict TypeScript, CI, API/web/worker shells, pinned local services, offline test guard                                 | Frozen install, typecheck, lint, test, and build all pass; clean typechecking builds dependency declarations first                                                                               |
| F-2  | Forward-only PostgreSQL/Drizzle schema, UUIDv7 identifiers, bigint money columns, explicit currencies, catalog tax constraint                    | Ten ordered migrations apply; schema tests verify constraints and runtime roles                                                                                                                  |
| F-3  | Forced RLS on every tenant table and transaction-local `app.tenant_id`                                                                           | Real PostgreSQL/Drizzle matrix proves isolation across every registered tenant-owned table, including missing context and concurrent tenants                                                     |
| F-4  | Immutable `Money`, Nairobi date helpers, centralized PII redaction                                                                               | Money has 100% statements, branches, functions, and lines coverage; phone, KRA PIN, OTP, message body, and email redaction are tested                                                            |
| F-5  | Better Auth, fixture phone/email OTP transports, server-trusted membership resolution, roles, atomic owner onboarding, authenticated proof shell | Session middleware derives tenant membership server-side and enters only the tenant transaction wrapper; auth/runtime role tests pass                                                            |
| F-6  | Generic versioned outbox, leases, deterministic exponential backoff, terminal incidents, least-privilege worker functions                        | Tests prove concurrent claims, transient/permanent failure, lease recovery, idempotent crash recovery, terminal states, and worker/app privilege boundaries                                      |
| F-7  | Structured Pino logs, fixture-gated Sentry, bounded redaction, immutable tenant LLM cost events                                                  | A synthetic offline LLM call writes a KES-minor cost event in real PostgreSQL; retry deduplication, conflicting reuse, append-only behavior, price audit fields, and tenant isolation are tested |

## Verification record

The documented local setup was exercised with the pinned PostgreSQL and Redis containers. The final verification sequence completed successfully:

| Command                          | Result                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged, all eight workspace projects resolved |
| `pnpm typecheck`                 | Passed; 11/11 dependency-aware tasks                              |
| `pnpm lint`                      | Passed; 7/7 workspaces                                            |
| `pnpm test`                      | Passed; 20 files and 80 tests                                     |
| `pnpm build`                     | Passed; 7/7 workspaces and all four Next.js routes generated      |

The 80 tests include 25 database tests, 20 core tests, 18 observability tests, 11 worker tests, 3 API tests, 2 auth transport tests, and 1 web configuration test. No test contacts KRA, Safaricom, Meta, Anthropic, Sentry, Better Stack, or any other external service.

## Security and reliability decisions

- The application, authentication, migration, and worker connections use separate roles. The app and worker roles are `NOBYPASSRLS`; neither owns tables.
- Tenant work is possible only inside a database transaction that sets `app.tenant_id` locally. The value comes from a verified session membership, never a request header or body.
- Outbox cross-tenant claiming is isolated behind fixed-search-path `SECURITY DEFINER` functions owned by a non-login role. The worker cannot directly modify outbox or incident rows.
- The app may enqueue only the safe outbox columns; it cannot forge attempts, claim state, results, or incidents.
- External effects use tenant-and-idempotency-key namespaces. A crash after the fixture effect but before acknowledgement replays safely.
- Sentry initializes a real transport only in explicit live mode. Fixture and CI operation stay offline even if a DSN is accidentally present.
- LLM usage events are append-only for the app role, use tenant-scoped required idempotency keys, store bigint cost in minor currency units, and retain the actual price snapshot used for calculation.
- Telemetry is structurally allow-listed and bounded for depth, collection size, and string length. Known PII is redacted before logging or error capture.

## Spec deviations and implementation choices

- The resolved package/file layout differs from the proposed plan where a flatter structure made the small Phase 0 packages easier to review. The public boundaries and acceptance behavior are unchanged.
- Local tooling uses pnpm 9.15.9 and the compatible exact dependency pins recorded in the lockfile. The plan's unavailable or unnecessary provisional packages were not added.
- PostgreSQL migrations are forward-only. “Backward compatible” is treated as safe expand/contract evolution, not reversible down migrations.
- The durable outbox remains PostgreSQL-backed. Redis is available for later BullMQ work, but is not made a second source of truth in Phase 0.
- The Next.js app uses its normal build output. Standalone output was avoided because symlink generation is unreliable inside the synchronized Google Drive workspace; this does not prevent Vercel deployment.
- No production deployment was performed. Phase 0 explicitly ships nothing customer-facing, so deploying a proof shell would add exposure without validating product value.
- No ambiguous tax, pricing, dunning, or tenant-to-customer behavior was invented.

## Prioritized gap register

### Gate before any external tenant or production launch

1. **X-1 — KRA eTIMS certification:** begin/continue certification immediately and resolve self-integration versus an approved third-party vendor in writing with KRA. This is the longest launch dependency.
2. **X-2 — Safaricom Daraja go-live:** obtain the Head Office paybill, bank letter, authorization forms, sandbox access, and Go Live approval.
3. **X-3 — ODPC registration and data map:** register before any non-Safuney tenant; document Kenya-region storage, processors, retention/deletion, incident handling, and any international transfer basis.
4. **X-4 — name clearance:** complete domain, KIPI trademark, and BRS checks before design or public launch.
5. **Production topology and secrets:** select Kenya-appropriate database/API/worker regions, secret management, backup/restore policy, recovery objectives, TLS/domain layout, and an on-call owner before live data exists.

### Resolve early in Phase 1

1. **Email recovery semantics:** email OTP is currently a separate supported sign-in identity, not a recovery address linked to an existing phone-first identity. Safe linking requires a verified account-linking ceremony and collision policy; silently merging identities would create an account-takeover risk.
2. **Phone OTP storage:** Better Auth 1.3.7's phone plugin stores the active code in its verification value, unlike the email plugin's hashed mode. The table is isolated to the dedicated auth role, but replace or wrap this flow with a hash-at-rest implementation before production authentication.
3. **Auth flow integration coverage:** add full HTTP-level Better Auth tests for OTP expiry, replay, send/verify rate limits, invalid sessions, suspended tenants, and the complete phone/email onboarding flow. The fixture transports and database boundaries are tested, but the entire framework lifecycle is not yet exercised end to end.
4. **Cookie/domain decision:** keep web and API on same-site custom domains in production, or explicitly validate the cross-site cookie and CSRF design. The current credentialed CORS configuration assumes one known web origin.
5. **Runnable services and configuration:** add an executable worker polling loop, production `start` scripts, graceful API/worker shutdown, database readiness checks, and fail-closed production environment validation. Live OTP transports remain deliberately unconfigured.
6. **Outbox fault injection:** add a database-level test that forces incident insertion to fail and proves the failure transition rolls back atomically. Successful terminal transitions are already tested.
7. **Crash-loop alerting:** a process that repeatedly dies after a successful external effect but before acknowledgement can keep reclaiming an expired max-attempt lease. Idempotency prevents duplicate external effects, but operations must alert on repeated expired leases and worker crashes so a healthy worker can finish acknowledgement.
8. **Operational observability:** configure production Sentry/Better Stack destinations, sampling, alert thresholds, retention, and access controls. Validate with synthetic production smoke events that contain no PII.
9. **Dependency maintenance:** plan an upgrade from Next.js 15.5 and enable the Next-specific ESLint plugin. The current production build passes but reports that plugin warning. Pin GitHub Actions to reviewed commit SHAs for stronger CI supply-chain controls.
10. **Workspace location:** use a normal local development path or WSL filesystem for day-to-day work. Google Drive synchronization substantially slows lint/build and can interfere with symlink-heavy tooling.
11. **Foundation test expansion:** add a migration checksum-mutation test; mirror the full all-table RLS matrix for tenant B; and explicitly prove cross-tenant update/delete affect no rows. The current blocking tenant-A all-table ORM proof and representative tenant-B checks meet the Phase 0 baseline, but the approved plan described the stronger matrix.

### Phase-boundary reminders

- Do not add pgvector until Q-3, live eTIMS until E-1, Daraja until E-6, WhatsApp until A-3, or cross-tenant aggregate priors until M-6.
- Phase 1 must block invoicing behavior on missing explicit tax classification; the database already prohibits a default tax class.
- Track the specification's two product measures—quote latency and DSO—from the first relevant workflow. Phase 0 cost metering does not replace those product metrics.
- Revisit the documented kill criteria at each phase gate, particularly eTIMS certification by month six and Safuney quote-time improvement after Phase 1.

## Deployment recommendation

When there is a deliberate shared environment, deploy only `apps/web` to Vercel. The Hono API and the continuously running worker need separate long-lived compute close to PostgreSQL/Redis; they should not be folded into Next.js route handlers. Use same-site custom domains, for example `app.<domain>` and `api.<domain>`, and keep database, logs, and PII-bearing services in the region approved by the data-protection assessment.

Vercel is therefore **not needed for Phase 0 completion**. The first deployment should follow—not precede—the domain, cookie, regional hosting, secrets, and compliance decisions above.

## Recommended next action

Accept Phase 0 as the engineering foundation, start X-1 through X-4 immediately if they are not already underway, and open Q-1 only after selecting the real Safuney SKU fixture and documenting its permitted handling. Keep the Phase 1 PR scope to one task ID at a time.
