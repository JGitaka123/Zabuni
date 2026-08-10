# Zabuni

**Quote-to-cash for East African B2B distributors.**
RFQ in → priced quote out → eTIMS-compliant invoice → collected cash. On a cadence, with agents that read their own results back.

---

## Why this exists

Kenyan B2B distributors (hygiene chemicals, medical supplies, agro-inputs, industrial consumables, PPE) run a workflow that is identical across every one of them and almost entirely manual:

1. An RFQ arrives by email or WhatsApp, often as a photo of a printed list.
2. Someone hand-matches line items to a price list in Excel.
3. A quote is typed up in Word, exported to PDF, sent back — usually 1–3 days later.
4. If won, an invoice is raised and must be transmitted to KRA eTIMS.
5. Payment lands 45–90 days later, chased by ad-hoc WhatsApp messages.

Every step leaks money. Quote latency loses deals. Manual pricing erodes margin. Non-compliant invoices are now automatically disallowed as expenses by KRA. And receivables sit uncollected because chasing is nobody's actual job.

Zabuni automates the loop and learns from it.

## The wedge

**eTIMS compliance is the door; the agent loop is the product.**

Since January 2024, eTIMS invoicing is mandatory for all Kenyan businesses, and from 1 January 2026 KRA's Income and Expense Validation Engine automatically cross-checks every income and expense line in a tax return against eTIMS invoice data. Non-compliant invoices mean disallowed expenses and audit flags — for the distributor _and_ for their customer.

That is a legally-forced, deadline-shaped, high-anxiety purchase trigger. It is also expensive and annoying to build, which keeps casual competitors out. We lead with it, and land the rest of the loop behind it.

## Documents

| Doc                                                                  | What it covers                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`CLAUDE.md`](./CLAUDE.md)                                           | Operating instructions for Claude Code. Read first.         |
| [`docs/01-product-spec.md`](./docs/01-product-spec.md)               | Users, jobs, scope, module-by-module functional spec        |
| [`docs/02-architecture.md`](./docs/02-architecture.md)               | Stack, services, deployment, multi-tenancy, security        |
| [`docs/03-data-model.md`](./docs/03-data-model.md)                   | Postgres schema, RLS, the outcome ledger                    |
| [`docs/04-agent-design.md`](./docs/04-agent-design.md)               | Agent contract, cadence, feedback loop, guardrails          |
| [`docs/05-integrations.md`](./docs/05-integrations.md)               | eTIMS, M-Pesa Daraja, WhatsApp Cloud API, email, Claude     |
| [`docs/06-billing-and-pricing.md`](./docs/06-billing-and-pricing.md) | Tiers, metering, M-Pesa recurring billing, unit economics   |
| [`docs/07-gtm-and-marketing.md`](./docs/07-gtm-and-marketing.md)     | ICP, positioning, paid acquisition, onboarding funnel       |
| [`docs/08-build-plan.md`](./docs/08-build-plan.md)                   | Phased backlog, milestone acceptance criteria               |
| [`docs/09-moat-and-risks.md`](./docs/09-moat-and-risks.md)           | Defensibility analysis, honest risk register, kill criteria |

## Status

Phase 0 (F-1 … F-7) and Phase 1 tasks Q-1, Q-2 and Q-3 are merged to `main`. Safuney Limited is design partner zero — a real hygiene/PPE distributor with real receivables. Phase 1 ships to Safuney only after the external prerequisites and milestone decisions in the completion report are resolved.

Q-4 is **not** started: Q-3 is engineering-complete but not formally accepted, because the ≥80% top-1 accuracy gate needs a held-out Safuney RFQ set that does not exist in this repository. See [`docs/reports/q-3-validation.md`](./docs/reports/q-3-validation.md).

See [`docs/reports/phase-0-completion.md`](./docs/reports/phase-0-completion.md) for verification evidence, design decisions, and the prioritized gap register, and [`docs/reports/foundation-hardening.md`](./docs/reports/foundation-hardening.md) for the operability and configuration work that closed part of it.

## Local foundation setup

Prerequisites: Node.js 22–24, pnpm 9.15.9, and Docker Desktop.

```powershell
Copy-Item .env.example .env
docker compose -f infra/local/compose.yml up -d
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All development and tests default to `INTEGRATION_MODE=fixture`; no external integration is contacted. Stop the local services with:

```powershell
docker compose -f infra/local/compose.yml down
```

## Handing this to a design partner

[`docs/handover-safuney.md`](./docs/handover-safuney.md) is the tester-facing guide: setup, how to sign in without a mail provider, what is worth testing, and what is deliberately not built yet. The most recent acceptance run is in [`docs/reports/acceptance-2026-08-10.md`](./docs/reports/acceptance-2026-08-10.md).

## Running the services

```powershell
pnpm --filter @zabuni/db db:migrate    # apply migrations
pnpm --filter @zabuni/api dev          # HTTP API on :3001
pnpm --filter @zabuni/web dev          # dashboard on :3000
pnpm --filter @zabuni/worker dev       # outbox drain
```

Each app also has a production `start` script that runs the compiled output from `pnpm build`.

Two behaviours are deliberate and will look like failures if you are not expecting them:

- **Configuration is fail-closed.** Services validate their whole environment at boot and refuse to start on any problem, reporting every one at once. Production specifically rejects `INTEGRATION_MODE=fixture`, non-https origins, and the placeholder auth secret.
- **The worker exits immediately with `worker_no_handlers_registered`.** No outbox delivery handler exists yet — the first is eTIMS transmission in E-3 — and the drain treats an unhandled event as a permanent failure. Booting an empty worker against a real queue would fail every pending delivery, so it refuses instead.

Sign-in uses an email one-time code. In fixture mode there is no mail provider, so codes are appended to `fixture-otp.jsonl` in the repository root; the database only ever stores a hash. Production refuses to boot in fixture mode, so that file cannot exist there.

The API exposes `/health` for liveness (never touches the database, so an outage cannot restart-loop a healthy process) and `/ready` for readiness (round-trips the database and returns 503 when it is unreachable).

## Name

**Zabuni** — Swahili for _tender / bid / quotation_. Instantly legible to every procurement officer in Kenya, Tanzania and Uganda, which is exactly our expansion footprint. See `docs/07` for alternates and the domain checklist.
