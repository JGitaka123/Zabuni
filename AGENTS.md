# AGENTS.md

Operating instructions for coding agents in this repository. Codex reads this file; Claude Code reads `CLAUDE.md`. **They must stay in sync — if you change one, change the other in the same commit.**

Read `CLAUDE.md` in full. It is the authoritative version. This file adds Codex-specific constraints.

## Read before writing any code

1. `CLAUDE.md` — non-negotiables, stack, conventions
2. `docs/08-build-plan.md` — find the current phase. **Do not build ahead of it.**
3. The doc for the module you are touching

## Codex-specific rules

**No network in the sandbox.** Every task must be completable and verifiable offline.

- `INTEGRATION_MODE=fixture` is the default in dev and test. Never write a test that requires reaching KRA eTIMS, Safaricom Daraja, Meta, or the Anthropic API.
- Every external client in `packages/*` ships with a fixture transport recorded under `packages/*/fixtures/`. Write the fixture first, then the client against it.
- If a task genuinely cannot be done offline, stop and say so in the PR description rather than stubbing something that silently passes.

**Do not run destructive or irreversible commands.** No `git push --force`, no history rewriting, no deleting migrations, no `DROP` outside an ephemeral test database.

**Migrations are forward-only.** Never edit a migration that already exists. Add a new one.

**Configuration is fail-closed.** Read the environment through `loadApiConfig`/`loadWorkerConfig` in `packages/core/config.ts`, never `process.env` in service code. A service with a bad environment refuses to boot rather than degrading — a fixture transport in production accepts every send and delivers nothing. See `CLAUDE.md` for the full rule.

**Ask instead of guessing.** If a spec is ambiguous on tax treatment, pricing precedence, dunning tone, or anything a tenant sends to their own customer, stop and ask. Do not resolve ambiguity by picking something reasonable and shipping it. Those four areas carry legal or reputational cost that a code review will not catch.

**Stay in scope.** One task ID per PR. If you find an unrelated bug, note it in the PR description — do not fix it in the same change.

## Verification — every PR must pass

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # strict, zero errors
pnpm lint
pnpm test             # includes the cross-tenant RLS test
pnpm build
```

The cross-tenant RLS test is a blocking gate. If it does not exist yet for a table you added, add it.

## PR description format

```
## Task
<ID from docs/08-build-plan.md>

## What changed
<2–5 bullets>

## Verification
<commands run, output summary>

## Spec deviations
<anything you did differently from docs/, and why — or "none">

## Open questions
<anything you had to assume — or "none">
```

The last two sections are the important ones. An empty "spec deviations" on a large change usually means you did not check.
