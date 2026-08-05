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

Phase 0 foundation is complete on the `codex/phase-0` branch. Safuney Limited is design partner zero — a real hygiene/PPE distributor with real receivables. Phase 1 ships to Safuney only after the external prerequisites and milestone decisions in the completion report are resolved.

See [`docs/reports/phase-0-completion.md`](./docs/reports/phase-0-completion.md) for verification evidence, design decisions, and the prioritized gap register.

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

## Name

**Zabuni** — Swahili for _tender / bid / quotation_. Instantly legible to every procurement officer in Kenya, Tanzania and Uganda, which is exactly our expansion footprint. See `docs/07` for alternates and the domain checklist.
