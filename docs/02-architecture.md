# 02 — Architecture

## Principles

1. **Boring where it counts.** Tax, money and compliance code should be the least clever code in the repo.
2. **One database.** Postgres holds relational data, vectors (pgvector), the job outbox, and the outcome ledger. Adding a second datastore costs more in operational surface than it saves.
3. **Deterministic core, probabilistic edges.** LLMs extract, classify, draft and rank. They never price, never compute tax, never decide to send money, and never write to the ledger without passing a schema validator.
4. **Everything reversible.** Every agent action has an undo or a compensating action. A tenant must be able to stop all outbound in one click.

## Services

```
┌─────────────┐   ┌──────────────┐   ┌─────────────────┐
│  apps/web   │   │  apps/api    │   │  apps/worker    │
│  Next.js    │──▶│  Hono        │◀──│  BullMQ         │
│  dashboard  │   │  REST + WH   │   │  agents + jobs  │
└─────────────┘   └──────┬───────┘   └────────┬────────┘
                         │                     │
              ┌──────────┴─────────────────────┴──────────┐
              │        Postgres (Neon) + pgvector          │
              │   tenants · catalog · quotes · invoices    │
              │   outbox · outcomes · agent_runs           │
              └───────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┬──────────────┐
     Redis           Cloudflare R2     Anthropic     External
   (BullMQ)          (files, PDFs)      (Claude)   eTIMS·Daraja·WA
```

**apps/web** — Next.js App Router. Server components for data-heavy views, client components for the quote builder. No business logic; calls `apps/api`.

**apps/api** — Hono. REST for the dashboard, webhook receivers for Daraja callbacks, WhatsApp events, and inbound email. Webhook handlers do one thing: verify signature, persist raw payload, enqueue. Never process inline — third-party webhooks retry aggressively and processing inline guarantees duplicates.

**apps/worker** — BullMQ consumers. Three queue classes:
- `ingest` — parse RFQs, embed catalog, OCR
- `transmit` — eTIMS, WhatsApp sends, PDF generation (outbox drain)
- `agents` — scheduled agent runs on cadence

Separate concurrency limits per class. An eTIMS outage must not starve RFQ parsing.

## Multi-tenancy

Shared database, shared schema, `tenant_id` on every business table, **Postgres RLS enforced**.

```sql
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quotes
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

The API sets `app.tenant_id` from the verified session at the start of every transaction. The application role has no `BYPASSRLS`. Migrations run as a separate role.

**Required test:** every table with a `tenant_id` has a test proving tenant A cannot read tenant B's rows through the ORM. This test is not optional and must run in CI.

Why not database-per-tenant: at our target scale (hundreds of tenants, not thousands of enterprises) the operational cost of migrating N databases outweighs the isolation benefit, and RLS gives most of the safety. Revisit if a single tenant exceeds 20% of total volume.

## The outbox pattern

Every side-effecting external call goes through `outbox`:

1. Business transaction writes domain rows **and** an outbox row atomically.
2. A worker drains outbox rows, calls the external API with an idempotency key, records the result.
3. Terminal states: `sent`, `failed_permanent`, `cancelled`. Non-terminal states retry with exponential backoff and a cap.
4. Anything in `failed_permanent` raises a tenant-visible incident.

This is the difference between "we sent your invoice to KRA" and "we think we sent your invoice to KRA." For a compliance product, that distinction is the entire value proposition.

## LLM usage

| Task | Model | Why |
|---|---|---|
| RFQ extraction from PDF/image | Sonnet (vision) | Accuracy on messy scans matters more than cost |
| Line-item → SKU candidate ranking | Haiku | High volume, narrow task, embeddings do most of the work |
| Quote follow-up / dunning message drafting | Sonnet | Tone is customer-facing and reputational |
| Message variant generation | Sonnet | Creative range needed for the learning loop |
| Classification, routing, intent | Haiku | Cheap, fast, sufficient |

**Rules:**
- Every LLM call has a JSON schema and a validator. Invalid output retries once, then escalates to human.
- Every call is logged with prompt hash, model, tokens, latency, and cost, attributed to a tenant. You cannot price the product if you cannot see per-tenant inference cost.
- Prompts live in `packages/agents/prompts/` as versioned files, never inline strings. Prompt changes are reviewed like code.
- No customer PII in prompts beyond what the task requires. Phone numbers are tokenised before they reach the model.

## Security

- Secrets in the platform secret manager, never in env files in the repo.
- eTIMS and Daraja credentials are per-tenant and encrypted at rest with a per-tenant data key (envelope encryption, KMS-backed).
- Signed webhooks verified before persistence. Daraja callbacks additionally IP-allowlisted to Safaricom ranges.
- Audit log for every state change on invoices, prices and agent policy — append-only, tenant-visible. Needed for KRA audits and for trust.
- Kenya Data Protection Act 2019: register as a data controller/processor with the ODPC before onboarding non-Safuney tenants. This is a real legal prerequisite, not paperwork to defer. Data residency: prefer an EU or africa-region Postgres; document the transfer basis.

## Environments

| Env | DB | eTIMS | Daraja | WhatsApp |
|---|---|---|---|---|
| local | Docker Postgres | fixture | fixture | fixture |
| ci | ephemeral Neon branch | fixture (nightly: sandbox) | sandbox | fixture |
| staging | Neon branch | KRA sandbox | Daraja sandbox | Meta test number |
| prod | Neon primary | live, per-tenant | live, per-tenant | live |

Note: Daraja 3.0's sandbox has had stability complaints in 2026. Keep fixture mode fully functional so development never blocks on Safaricom's sandbox being down.

## Scaling notes

The load shape is bursty and small: a distributor gets 20–200 RFQs a month, not per second. The scaling constraints are **not** request throughput. They are:

- **LLM cost per tenant** — the real COGS. Cache aggressively, prefer embeddings over generation, use Haiku wherever possible.
- **eTIMS latency and downtime** — KRA's endpoint is the least reliable dependency. Queue depth and retry policy matter more than horizontal scaling.
- **WhatsApp template approval** — a human-speed bottleneck. See `docs/05`.

Do not prematurely optimise for concurrency. Optimise for correctness and cost per tenant.
