# Foundation hardening report

**Scope:** Phase 0 gap register items "Resolve early in Phase 1" — 5 (runnable services and configuration), 6 (outbox fault injection), 7 (crash-loop alerting), 9 (dependency maintenance), 11 (foundation test expansion).

**Status:** complete for the items listed above; two items remain open and are recorded at the end.

**Review date:** 2026-08-09

## Why this work

The Phase 0 completion report listed these as the engineering gaps to close before Phase 1 workflow code depends on the foundation. None of them add product behaviour. No tax, pricing, dunning, or tenant-to-customer behaviour was invented, and nothing was built ahead of the current phase.

## Defects found and fixed

Four of these were live defects, not missing features. The fourth was found after the first merge, when it turned CI red on `main`.

### 1. Production could boot with fixture transports

`apps/api` chose its OTP transport with `INTEGRATION_MODE === "fixture" ? new FixtureOtpTransport() : ...`, and `INTEGRATION_MODE` defaulted to `fixture` when unset. A production deploy that forgot the variable would have started successfully with `FixtureOtpTransport`, which records every code in memory, performs no I/O, and resolves successfully. Sign-in would have appeared healthy while no tenant ever received an SMS.

An unrecognised value was equally unsafe: `INTEGRATION_MODE=fixtrue` silently disabled the fixture embedding provider and left Sentry offline, failing only later at runtime.

`packages/core/src/config.ts` now parses and validates the whole environment at boot, aggregates every problem into one `ConfigurationError`, and refuses to start. Production rejects `fixture` mode, non-https origins, secrets under 32 characters, and the two committed placeholder secrets. Sandbox stays legal in production so a staging deploy can run against vendor sandboxes. Error messages name the offending variable and never echo its value.

### 2. The ESLint import boundary for the cross-tenant outbox was inert

`eslint.config.mjs` declared `no-restricted-imports` twice: once for `apps/api`/`apps/web` (forbidding both `@zabuni/db/admin` and `@zabuni/db/privileged/outbox`) and once for all of `apps/**` (forbidding only `@zabuni/db/admin`).

ESLint flat config **replaces** a rule's options when a later block sets the same rule; it does not merge them. Because the broader `apps/**` block came last, it overwrote the narrower one, and the `@zabuni/db/privileged/outbox` restriction never applied to anything. Request-path code could import the cross-tenant outbox boundary with no lint error — verified directly before the fix.

That guard exists to enforce non-negotiable 1 (never use a service-role connection in request-path code). The blocks are now ordered narrowest-last and the request-path block restates every path it needs. `apps/api/test/import-boundaries.test.ts` asserts the _resolved_ rule options for representative files in each app, so a future reordering fails a test rather than silently disarming the boundary.

### 3. The stall check never ran on a freshly started worker

Caught by its own test during development: the drain loop's stall sampler compared `now() - lastStallCheck` against the interval with `lastStallCheck` initialised to `0`, which suppressed the first sample. A worker starting up into an already-stalled queue would have stayed silent for a full interval. It now initialises to `Number.NEGATIVE_INFINITY` so the first iteration always samples.

### 4. Concurrent role provisioning raced migrations in CI

Found after the first merge: `main` went red with `PostgresError: tuple concurrently updated` in `rls.integration.test.ts`'s `beforeAll`, even though the identical tree had passed on the pull request. A flake, not a content difference.

Roles are cluster-wide, and Turbo runs each package's tests as a separate process against one database. The `CREATE ROLE`/`ALTER ROLE`/`GRANT` block in the `packages/db` tests therefore raced the `GRANT`, `REVOKE`, and `ALTER FUNCTION ... OWNER TO` statements inside `applyMigrations` running in `packages/catalog` or `packages/observability`. Two sessions updating the same `pg_authid` tuple fail outright. The CI log shows the collision across two distinct backend PIDs.

`applyMigrations` already serialises on `pg_advisory_xact_lock(hashtext('zabuni:migrations'))`; the test provisioning did not take it. Both provisioning functions now do.

Confirmed causally rather than by a passing run: 180 concurrent role-DDL statements produced 21 `tuple concurrently updated` errors without the lock, and zero with it.

This race predates this work — it needed only two packages doing cluster-wide DDL at once — but the added test file shifted timing enough to expose it.

## Delivered scope

| Gap | Outcome                                                                                                                                                                                                                                                                         | Evidence                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 5   | Fail-closed `loadApiConfig`/`loadWorkerConfig`; executable worker entry point with poll loop, error backoff and cooperative shutdown; SIGTERM/SIGINT handling and pool draining in the API; database readiness gate at boot; `/ready` probe; `start` scripts for all three apps | 17 config tests, 10 loop tests, 4 readiness tests |
| 6   | Fault injection proving `app.fail_outbox` rolls back atomically when the incident insert fails                                                                                                                                                                                  | `outbox.integration.test.ts`                      |
| 7   | Migration `0018` exposes an aggregate-only stall snapshot; the loop alerts once per episode on exhausted leases and warns on merely-expired ones                                                                                                                                | 3 loop tests, 2 integration tests                 |
| 9   | Next.js ESLint plugin wired in and verified firing; `no-html-link-for-pages` disabled for this App Router-only project                                                                                                                                                          | `next build` no longer warns                      |
| 11  | Migration checksum-mutation test; full tenant-B RLS matrix; cross-tenant update/delete proven to affect no rows                                                                                                                                                                 | 3 migration-ledger tests, extended RLS suite      |

### Crash-loop visibility (gap 7)

`app.claim_outbox` reclaims rows whose lease expired while still `processing`. That branch has no `attempt_count` guard, so a worker that dies after the external effect but before acknowledgement reclaims the same row indefinitely. Idempotency keeps the external effect safe, which is exactly why the loop is invisible in delivery results.

Migration `0018_outbox_stall_visibility.sql` adds `app.outbox_stall_snapshot`, a `SECURITY DEFINER` function with a fixed `search_path`, owned by `zabuni_outbox_claim_owner` and executable only by `zabuni_worker`. It returns three counts and nothing else — no tenant ids, payloads, idempotency keys, or error text — so a globally-scoped worker polling it does not become a cross-tenant read path. A migration test asserts that property against the SQL with comments stripped.

The worker raises `outbox_crash_loop_suspected` (error, plus one Sentry capture per episode) when any expired lease has no attempts left, and `outbox_lease_expired` (warning) otherwise. Claim semantics were deliberately not changed: stranding deliveries to break the loop is an operational decision, not one to make silently in code.

### Why the worker refuses to start

The drain marks any claim with no registered handler as a permanent failure and opens a tenant incident. No delivery handler exists yet — the first is eTIMS transmission (E-3, Phase 2). An empty worker pointed at a real queue would therefore destroy every queued delivery, so `main()` logs `worker_no_handlers_registered` and exits non-zero instead. The loop, shutdown, readiness and alerting paths around it are complete and tested; only the handler registry is empty, and it must stay empty until E-3.

## Verification

Run against PostgreSQL 16 with pgvector, `INTEGRATION_MODE=fixture`, no network.

| Command                          | Result                                        |
| -------------------------------- | --------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed                                        |
| `pnpm typecheck`                 | Passed; 13/13 tasks                           |
| `pnpm lint`                      | Passed; 8/8 tasks                             |
| `pnpm test`                      | Passed; 187 tests across 8 packages (was 145) |
| `pnpm build`                     | Passed; 8/8 tasks, no Next.js plugin warning  |

The 42 added tests are 17 config, 10 worker loop, 4 readiness, 3 import-boundary, 3 migration-ledger, 3 outbox stall/fault-injection, and 2 migration-content assertions. No test contacts an external service.

## Spec deviations

- `packages/core` gained a `config` module. `CLAUDE.md` describes the package as "Money, dates, redaction, shared types"; configuration is shared and depends on nothing else, and a new package for one module was not worth the workspace surface.
- `MembershipRuntime` and `OutboxWorkerStore` gained a `ping()` method purely so readiness probes reflect real connectivity rather than process liveness.
- `pnpm format:check` fails on 29 files. This is pre-existing and was confirmed against the unmodified base commit; it is not part of CI. Files touched here were formatted, so the count did not grow from this work.

## Still open

- **GitHub Actions SHA pinning** (gap 9, second half). Actions are still referenced by tag (`actions/checkout@v7`). Resolving tags to reviewed commit SHAs needs GitHub API access to those repositories, which this environment does not have, and guessing a SHA would break CI. This needs a maintainer with network access to run the resolution and record the SHAs.
- **HNSW index is global** (carried over from the Q-3 report). Exact tenant-filtered ordering protects correctness today; larger multi-tenant scale needs partitioning or a tenant-aware ANN strategy before approximate search is enabled.

Gap register items 1–4, 8 and 10 are unchanged: they are external, operational, or workspace concerns rather than repository changes.

## Addendum: live functional verification

The repository gates had never actually run the services. This pass booted the API and drove the real product flow over HTTP in fixture mode, which is what `CLAUDE.md`'s definition of done requires ("the happy path works in `fixture` mode without network").

Verified working end to end: phone OTP sign-in, tenant onboarding, tenant-scoped catalog reads, item creation, the Q-3 hybrid matcher with component-level explanations, graceful shutdown on the production entrypoint, and the worker's refusal to boot without handlers. Tax classification blocks correctly at both gates (no class, and a class with no audit basis), money round-trips as a bigint string, and a second tenant sees neither the first tenant's items nor its match candidates.

Two defects surfaced that no unit test could have caught.

### Bind failures were invisible

`service_started` was logged immediately after `serve()`, but binding is asynchronous. A port conflict therefore logged "service*started" and \_then* died on an unhandled `'error'` event, printing a raw stack that reached neither Sentry nor the structured log stream. Observed directly: a false `service_started`, followed by an `EADDRINUSE` stack trace.

The listening callback now reports the started event, and a bind error is captured and logged as `service_listen_failed` with its `code` before a non-zero exit.

### Crashes were invisible

Neither service installed `uncaughtException` or `unhandledRejection` handlers. Node terminates on both and writes a raw stack to stderr, so a crash was indistinguishable from a clean exit in tenant-visible telemetry — the swallowed-failure mode invariant 4 exists to prevent.

`installFatalHandlers` in `packages/observability` now captures to Sentry, writes a structured record, runs best-effort cleanup, and exits non-zero. It reports the first fatal only, so a cascade cannot loop; it survives a reporter that itself throws; and it logs the error name only, because messages and stacks can carry phone numbers or message bodies.

### Not fixed: phone OTP is stored in plaintext

Confirmed live rather than inferred — a sent code was read straight out of `auth_verification.value` as `738118:0`.

Better Auth's `emailOTP` plugin supports `storeOTP: "hashed" | "plain" | "encrypted"`. Its `phoneNumber` plugin supports no such option and compares the submitted code against the stored string directly. This is unchanged in the latest release (1.6.26, checked against the published tarball), so an upgrade does not fix it.

Closing it means implementing hash-at-rest around the framework's phone flow. That is an authentication-critical change whose failure mode is account takeover, so it is left as an explicit owner decision rather than resolved unilaterally. It remains gap-register item 2 and a pre-production blocker.

### Re-committing an import reported it as missing

Driving the Q-1 import flow surfaced a third defect. Committing an import a second time returned `catalog_import_not_found` (404) instead of reporting that it was already committed.

The cause is a correct security rule with a wrong error path. Committed imports are immutable: the RLS policy on `catalog_imports` is `USING (status = 'staged')` for update, so the `SELECT ... FOR UPDATE` that opens `commitStagedImport` cannot lock a committed row and returns nothing. The service read that as "was not found".

A rep who double-clicks Commit was therefore told the import did not exist, which reads as data loss immediately after a successful import. The lock now falls back to an unlocked read to distinguish the two cases: an existing import reports `not staged` (409) and a genuinely absent one still reports `not found` (404). The immutability guarantee is untouched -- the fallback never attempts to lock the committed row.

Confirmed live against the running API: 409 for the already-committed import, 404 for an absent id.

## Current authentication release guard (2026-08-16)

Phone OTP has since been removed because the Better Auth phone plugin could not
meet the hash-at-rest requirement. Email OTP is the only sign-in channel and is
stored hashed. Fixture mode remains fully offline. Sandbox and live API startup
now fail closed until an approved email delivery provider is wired; the service
can no longer report healthy while every OTP send is guaranteed to fail.

Cookie-authenticated custom mutations now require the exact configured web
origin, and JSON/multipart routes reject misleading content types. Better Auth
routes remain under Better Auth's own trusted-origin validation.
