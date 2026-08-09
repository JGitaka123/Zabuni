# Foundation hardening report

**Scope:** Phase 0 gap register items "Resolve early in Phase 1" — 5 (runnable services and configuration), 6 (outbox fault injection), 7 (crash-loop alerting), 9 (dependency maintenance), 11 (foundation test expansion).

**Status:** complete for the items listed above; two items remain open and are recorded at the end.

**Review date:** 2026-08-09

## Why this work

The Phase 0 completion report listed these as the engineering gaps to close before Phase 1 workflow code depends on the foundation. None of them add product behaviour. No tax, pricing, dunning, or tenant-to-customer behaviour was invented, and nothing was built ahead of the current phase.

## Defects found and fixed

Three of these were live defects, not missing features.

### 1. Production could boot with fixture transports

`apps/api` chose its OTP transport with `INTEGRATION_MODE === "fixture" ? new FixtureOtpTransport() : ...`, and `INTEGRATION_MODE` defaulted to `fixture` when unset. A production deploy that forgot the variable would have started successfully with `FixtureOtpTransport`, which records every code in memory, performs no I/O, and resolves successfully. Sign-in would have appeared healthy while no tenant ever received an SMS.

An unrecognised value was equally unsafe: `INTEGRATION_MODE=fixtrue` silently disabled the fixture embedding provider and left Sentry offline, failing only later at runtime.

`packages/core/src/config.ts` now parses and validates the whole environment at boot, aggregates every problem into one `ConfigurationError`, and refuses to start. Production rejects `fixture` mode, non-https origins, secrets under 32 characters, and the two committed placeholder secrets. Sandbox stays legal in production so a staging deploy can run against vendor sandboxes. Error messages name the offending variable and never echo its value.

### 2. The ESLint import boundary for the cross-tenant outbox was inert

`eslint.config.mjs` declared `no-restricted-imports` twice: once for `apps/api`/`apps/web` (forbidding both `@zabuni/db/admin` and `@zabuni/db/privileged/outbox`) and once for all of `apps/**` (forbidding only `@zabuni/db/admin`).

ESLint flat config **replaces** a rule's options when a later block sets the same rule; it does not merge them. Because the broader `apps/**` block came last, it overwrote the narrower one, and the `@zabuni/db/privileged/outbox` restriction never applied to anything. Request-path code could import the cross-tenant outbox boundary with no lint error — verified directly before the fix.

That guard exists to enforce non-negotiable 1 (never use a service-role connection in request-path code). The blocks are now ordered narrowest-last and the request-path block restates every path it needs. `apps/api/test/import-boundaries.test.ts` asserts the *resolved* rule options for representative files in each app, so a future reordering fails a test rather than silently disarming the boundary.

### 3. The stall check never ran on a freshly started worker

Caught by its own test during development: the drain loop's stall sampler compared `now() - lastStallCheck` against the interval with `lastStallCheck` initialised to `0`, which suppressed the first sample. A worker starting up into an already-stalled queue would have stayed silent for a full interval. It now initialises to `Number.NEGATIVE_INFINITY` so the first iteration always samples.

## Delivered scope

| Gap | Outcome | Evidence |
| --- | --- | --- |
| 5 | Fail-closed `loadApiConfig`/`loadWorkerConfig`; executable worker entry point with poll loop, error backoff and cooperative shutdown; SIGTERM/SIGINT handling and pool draining in the API; database readiness gate at boot; `/ready` probe; `start` scripts for all three apps | 17 config tests, 10 loop tests, 4 readiness tests |
| 6 | Fault injection proving `app.fail_outbox` rolls back atomically when the incident insert fails | `outbox.integration.test.ts` |
| 7 | Migration `0018` exposes an aggregate-only stall snapshot; the loop alerts once per episode on exhausted leases and warns on merely-expired ones | 3 loop tests, 2 integration tests |
| 9 | Next.js ESLint plugin wired in and verified firing; `no-html-link-for-pages` disabled for this App Router-only project | `next build` no longer warns |
| 11 | Migration checksum-mutation test; full tenant-B RLS matrix; cross-tenant update/delete proven to affect no rows | 3 migration-ledger tests, extended RLS suite |

### Crash-loop visibility (gap 7)

`app.claim_outbox` reclaims rows whose lease expired while still `processing`. That branch has no `attempt_count` guard, so a worker that dies after the external effect but before acknowledgement reclaims the same row indefinitely. Idempotency keeps the external effect safe, which is exactly why the loop is invisible in delivery results.

Migration `0018_outbox_stall_visibility.sql` adds `app.outbox_stall_snapshot`, a `SECURITY DEFINER` function with a fixed `search_path`, owned by `zabuni_outbox_claim_owner` and executable only by `zabuni_worker`. It returns three counts and nothing else — no tenant ids, payloads, idempotency keys, or error text — so a globally-scoped worker polling it does not become a cross-tenant read path. A migration test asserts that property against the SQL with comments stripped.

The worker raises `outbox_crash_loop_suspected` (error, plus one Sentry capture per episode) when any expired lease has no attempts left, and `outbox_lease_expired` (warning) otherwise. Claim semantics were deliberately not changed: stranding deliveries to break the loop is an operational decision, not one to make silently in code.

### Why the worker refuses to start

The drain marks any claim with no registered handler as a permanent failure and opens a tenant incident. No delivery handler exists yet — the first is eTIMS transmission (E-3, Phase 2). An empty worker pointed at a real queue would therefore destroy every queued delivery, so `main()` logs `worker_no_handlers_registered` and exits non-zero instead. The loop, shutdown, readiness and alerting paths around it are complete and tested; only the handler registry is empty, and it must stay empty until E-3.

## Verification

Run against PostgreSQL 16 with pgvector, `INTEGRATION_MODE=fixture`, no network.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck` | Passed; 13/13 tasks |
| `pnpm lint` | Passed; 8/8 tasks |
| `pnpm test` | Passed; 187 tests across 8 packages (was 145) |
| `pnpm build` | Passed; 8/8 tasks, no Next.js plugin warning |

The 42 added tests are 17 config, 10 worker loop, 4 readiness, 3 import-boundary, 3 migration-ledger, 3 outbox stall/fault-injection, and 2 migration-content assertions. No test contacts an external service.

## Spec deviations

- `packages/core` gained a `config` module. `CLAUDE.md` describes the package as "Money, dates, redaction, shared types"; configuration is shared and depends on nothing else, and a new package for one module was not worth the workspace surface.
- `MembershipRuntime` and `OutboxWorkerStore` gained a `ping()` method purely so readiness probes reflect real connectivity rather than process liveness.
- `pnpm format:check` fails on 29 files. This is pre-existing and was confirmed against the unmodified base commit; it is not part of CI. Files touched here were formatted, so the count did not grow from this work.

## Still open

- **GitHub Actions SHA pinning** (gap 9, second half). Actions are still referenced by tag (`actions/checkout@v7`). Resolving tags to reviewed commit SHAs needs GitHub API access to those repositories, which this environment does not have, and guessing a SHA would break CI. This needs a maintainer with network access to run the resolution and record the SHAs.
- **HNSW index is global** (carried over from the Q-3 report). Exact tenant-filtered ordering protects correctness today; larger multi-tenant scale needs partitioning or a tenant-aware ANN strategy before approximate search is enabled.

Gap register items 1–4, 8 and 10 are unchanged: they are external, operational, or workspace concerns rather than repository changes.
