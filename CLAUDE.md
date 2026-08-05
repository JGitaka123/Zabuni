# CLAUDE.md

Operating instructions for Claude Code working in this repository.

## What this is

Zabuni is a multi-tenant SaaS for East African B2B distributors: RFQ intake → quoting → eTIMS invoicing → M-Pesa collection → autonomous receivables and restock agents.

Read `docs/01-product-spec.md` and `docs/02-architecture.md` before writing code. Read `docs/08-build-plan.md` to find the current phase. Do not build ahead of the current phase.

## Non-negotiables

These are correctness requirements, not preferences. Violating any of them is a bug even if tests pass.

1. **Every query is tenant-scoped.** Postgres Row-Level Security is on for every tenant-owned table. Never bypass RLS. Never use a service-role connection in request-path code. If you need a privileged operation, add an explicit, audited function in `packages/db/src/privileged/` and justify it in the PR description.

2. **Money is never a float.** All monetary values are `bigint` minor units (KES cents) plus an ISO-4217 currency code. Use `Money` from `packages/core/money.ts`. Never `number` for currency. Never `parseFloat` on a price.

3. **Tax classification is never inferred silently.** Every catalog item carries an explicit KRA tax classification (16% standard / zero-rated / exempt). If an item lacks one, block invoicing and surface a task. Do not default to 16%. Misclassification is the single most common eTIMS failure and it is the customer's legal exposure, not ours to guess at.

4. **eTIMS transmission is idempotent and never silently dropped.** Every invoice transmission has a durable outbox row, an idempotency key, and a terminal state. A failed transmission is a visible, actionable incident in the tenant's UI — never a swallowed log line.

5. **Every agent action writes an outcome row.** No exceptions. See `docs/04-agent-design.md`. An action without an attributable outcome is not an agent, it is a cron job, and it makes the product worthless.

6. **No autonomous send above the tenant's approval threshold.** Agents propose; the threshold decides whether a human confirms. Default thresholds are conservative. Never raise a tenant's threshold in code.

7. **PII stays in-region and minimal.** Kenya's Data Protection Act 2019 applies. Do not log phone numbers, KRA PINs, or message bodies in plaintext. Use the redaction helpers in `packages/core/redact.ts`.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript, strict mode, no `any` without a `// why:` comment
- **Web:** Next.js (App Router), React, Tailwind, shadcn/ui
- **API:** Hono, deployed as a separate service (not Next route handlers — workers and API share it)
- **DB:** Postgres (Neon) + Drizzle ORM + pgvector
- **Queue:** BullMQ on Redis (Upstash)
- **Storage:** Cloudflare R2 (S3-compatible)
- **LLM:** Anthropic SDK. Sonnet for extraction and drafting, Haiku for classification and routing.
- **Auth:** better-auth, phone-first (SMS OTP) with email fallback
- **Errors:** Sentry. **Logs:** structured JSON to Betterstack.

## Conventions

**Structure**
```
apps/web         Next.js dashboard
apps/api         Hono HTTP API
apps/worker      BullMQ consumers, agent runtimes, schedulers
packages/core    Money, dates, redaction, shared types
packages/db      Drizzle schema, migrations, RLS policies
packages/agents  Agent definitions, tools, evaluators
packages/etims   KRA eTIMS client (VSCU/OSCU)
packages/mpesa   Daraja client
packages/wa      WhatsApp Cloud API client
```

**Code**
- Handlers are thin. Business logic lives in `packages/*` services and is unit-testable without HTTP.
- All external calls go through a typed client in `packages/*` with retry, timeout, and circuit-breaker. Never `fetch` a third party directly from a route or worker.
- Every external integration has a recorded-fixture test mode. `INTEGRATION_MODE=fixture|sandbox|live`.
- Migrations are forward-only. Never edit a shipped migration.
- Timezone is `Africa/Nairobi` for all business-day logic. Store UTC.

**Testing**
- Vitest. Unit tests for pricing, tax, money, dunning policy — these are the parts where a bug costs the customer money or legal exposure.
- Integration tests run against fixtures by default, sandbox in CI nightly.
- Any change to pricing, tax classification, or dunning escalation requires a test demonstrating the new behaviour. No exceptions.

**Git**
- Conventional commits.
- One phase task per PR. Reference the task ID from `docs/08-build-plan.md`.

## Working style

- **Ask before inventing product behaviour.** If a spec is ambiguous, ask. Do not resolve ambiguity by guessing and shipping — especially on tax, dunning tone, or anything a customer sends to their customer.
- **Prefer boring.** This product's value is reliability and compliance, not novelty. Choose the well-trodden library.
- **When you touch eTIMS, Daraja, or WhatsApp, re-read `docs/05-integrations.md`.** These APIs have changed recently and the doc records version-dated behaviour. If reality contradicts the doc, update the doc in the same PR.
- **Do not add a vector database.** pgvector is sufficient at our scale and one fewer thing to operate.
- **Do not build a mobile app.** WhatsApp is the mobile surface. See `docs/01`.

## Definition of done

A task is done when: tests pass, RLS verified with a cross-tenant test, the happy path works in `fixture` mode without network, errors surface to the UI rather than the console, and `docs/` reflects any behaviour you changed.
