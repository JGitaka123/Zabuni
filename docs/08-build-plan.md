# 08 — Build Plan

Task IDs are stable. Reference them in commits and PRs. Do not build ahead of the current phase.

**Two things start on day one and run in parallel with everything below, because they are external-dependency long poles:**

- **X-1 — KRA eTIMS certification.** Begin the certification process immediately. Resolve the self-integration vs. third-party-vendor question in writing with KRA.
- **X-2 — Safaricom Daraja go-live.** Head Office paybill, bank letter, authorisation forms, Go Live application.
- **X-3 — ODPC data controller registration.** Required before any non-Safuney tenant.
- **X-4 — Name clearance.** Domains, KIPI trademark search, BRS name check. Before any design work.

---

## Phase 0 — Foundation (weeks 1–3)

| ID  | Task                                                            | Done when                                                      |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| F-1 | Monorepo scaffold, Turborepo, pnpm, strict TS, CI               | `pnpm build` and `pnpm test` green from clean clone            |
| F-2 | Postgres + Drizzle, core schema from `docs/03`                  | Migrations apply forward and backward-compatibly               |
| F-3 | **RLS policies + cross-tenant test**                            | Test proves tenant A cannot read tenant B via ORM. Blocking.   |
| F-4 | `packages/core`: Money, dates (Africa/Nairobi), redaction       | 100% unit coverage on Money                                    |
| F-5 | Auth: better-auth, email OTP, roles                             | Sign-up → tenant → session with `app.tenant_id` set            |
| F-6 | Outbox table + generic drain worker                             | Idempotency and terminal states proven under simulated failure |
| F-7 | Observability: Sentry, structured logs, per-tenant cost logging | An LLM call appears in `usage_events` with a cost              |

Nothing customer-facing ships in Phase 0. Resist the urge.

## Phase 1 — Quote engine (weeks 4–9)

| ID  | Task                                                               | Done when                                                      |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Q-1 | Catalog CRUD + CSV/Excel import with column mapping                | Safuney's real SKU list imports cleanly                        |
| Q-2 | Tax classification workflow, blocking on unclassified              | Cannot invoice an unclassified item. Enforced in DB.           |
| Q-3 | pgvector embeddings + hybrid matcher + alias table                 | Top-1 ≥80% on Safuney's held-out RFQ set                       |
| Q-4 | RFQ intake: upload + manual                                        | PDF/Excel/photo accepted, stored to R2                         |
| Q-5 | Claude extraction with vision, schema-validated, confidence-scored | 20-line printed-RFQ photo → structured lines in <30s           |
| Q-6 | Pricing engine with rule precedence + explanation                  | Every line returns which rule fired. Unit-tested exhaustively. |
| Q-7 | Quote builder UI                                                   | Rep produces a quote from a parsed RFQ in <5 min               |
| Q-8 | Quote PDF + public link + open tracking                            | Buyer opens link; `first_opened_at` recorded                   |
| Q-9 | Buyer-side accept                                                  | Accept converts quote → order                                  |

**Milestone gate:** Safuney's sales team uses this for real quotes for two weeks. Median RFQ-to-quote-sent under 15 minutes. Do not proceed until this holds.

## Phase 2 — eTIMS and payments (weeks 10–15)

| ID  | Task                                                   | Done when                                                 |
| --- | ------------------------------------------------------ | --------------------------------------------------------- |
| E-1 | `packages/etims` OSCU client, fixtures, error taxonomy | All documented error codes have a tenant-readable message |
| E-2 | The four eTIMS invariants as guards                    | Each has a test proving it blocks the violation           |
| E-3 | Invoice generation + transmission via outbox           | CUIN + QR returned, rendered, verifiable on KRA portal    |
| E-4 | Failure incidents surfaced in UI                       | Permanent failure visible to tenant within 60s            |
| E-5 | Credit notes and cancellations per KRA rules           | Correction requires prior cancellation                    |
| E-6 | `packages/mpesa`: STK push from invoice link           | Buyer pays from phone; payment recorded                   |
| E-7 | C2B callback receiver + dedupe                         | Duplicate `TransactionID` handled idempotently            |
| E-8 | Reconciliation matcher + split proposals               | Handles partial, lumped, and mis-referenced payments      |
| E-9 | Accounting export (QuickBooks, Sage, CSV)              | Round-trips without manual fixing                         |

**Milestone gate:** Safuney issues every invoice through Zabuni for one full month. Zero unresolved transmission failures.

## Phase 3 — Agents (weeks 16–22)

| ID  | Task                                                                | Done when                                                     |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| A-1 | Agent runtime: cadence, run/action/outcome ledger                   | Every action acquires an outcome, incl. `no_response` sweeper |
| A-2 | Guardrail layer: caps, quiet hours, prohibited content, kill switch | Kill switch cancels queued outbox in <60s. Tested.            |
| A-3 | `packages/wa` Cloud API client + template registry                  | Templates map to Meta IDs; opt-in enforced in code            |
| A-4 | **Agent 1** — quote follow-up                                       | Runs on cadence; outcomes attributed                          |
| A-5 | Thompson sampling + sample-size floors                              | Cannot retire a variant under 60 sends. Tested.               |
| A-6 | **Agent 2** — receivables ladder                                    | Full ladder live; payment mid-ladder cancels queued actions   |
| A-7 | Holdout cohort (15%) + comparison reporting                         | Delta computed honestly and visible                           |
| A-8 | **Agent 3** — restock prediction                                    | Weekly run; rep approval for first 8 weeks                    |
| A-9 | Owner weekly digest via WhatsApp + email                            | Delivered, opened, useful                                     |

**Milestone gate:** measurable DSO reduction at Safuney versus the holdout. This number is your product.

## Phase 4 — Multi-tenant hardening (weeks 23–28)

| ID  | Task                                                         | Done when                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| M-1 | Self-serve onboarding + guided catalog import                | New tenant to first quote without engineering help                  |
| M-2 | Per-tenant eTIMS/Daraja credential vault, envelope-encrypted | Keys never in plaintext at rest or in logs                          |
| M-3 | Metering + plan limits + overage warnings at 80/100%         | No silent overage possible                                          |
| M-4 | Subscription billing: Ratiba, card, invoice fallback         | Recurring charge succeeds and retries correctly                     |
| M-5 | Buyer portal                                                 | Buyer sees all their quotes/invoices across one tenant              |
| M-6 | Cross-tenant global prior for cold-start agents              | Aggregate only. No content or customer data leakage. Audited.       |
| M-7 | Load and failure drills                                      | eTIMS outage, WhatsApp ban, Daraja timeout — all degrade gracefully |

**Milestone gate:** three paying design partners onboarded without engineering intervention.

## Phase 5 — Scale (week 29+)

API access · multi-branch · Tanzania/Uganda evaluation (only if Kenya is genuinely working) · deeper accounting integrations · buyer-side network features.

---

## Order-of-work rules

1. **Correctness before features.** A wrong tax classification is worse than a missing feature.
2. **Safuney before anyone.** Every phase gate is validated on a real business with real money.
3. **No abstraction for hypothetical countries.** Kenya only until Kenya works.
4. **Measure the two numbers continuously** — quote latency and DSO. They are the product, the case study, and the ad creative.
