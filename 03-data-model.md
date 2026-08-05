# 03 — Data Model

Postgres. Drizzle ORM. All tenant tables carry `tenant_id uuid not null` with RLS.

Conventions: `id` is uuidv7 (time-ordered). Money is `bigint` minor units + `currency char(3)`. All timestamps `timestamptz`, stored UTC. Soft delete via `deleted_at` only where audit requires it.

## Core

```
tenants
  id, legal_name, trading_name, kra_pin, vat_registered,
  etims_mode ('oscu'|'vscu'), etims_branch_id,
  timezone default 'Africa/Nairobi', currency default 'KES',
  plan, status, created_at

users
  id, tenant_id, phone_e164, email, name, role
  role ∈ owner | manager | sales | finance | readonly

customers                      -- the tenant's buyers
  id, tenant_id, legal_name, kra_pin, vat_registered,
  segment, credit_limit_minor, payment_terms_days,
  primary_phone_e164, billing_email, delivery_zone_id,
  risk_score, avg_days_to_pay, created_at

customer_contacts
  id, tenant_id, customer_id, name, phone_e164, email,
  role_hint, wa_opt_in_at, wa_opt_out_at
```

`wa_opt_in_at` is legally load-bearing. No WhatsApp template send without it.

## Catalog

```
items
  id, tenant_id, sku, description, brand, pack_size, uom,
  cost_minor, cost_currency, fx_buffer_bps,
  tax_class ('standard_16'|'zero_rated'|'exempt'),   -- NOT NULL, no default
  kra_item_code, hs_code, lead_time_days,
  min_margin_bps, active

item_embeddings
  item_id, embedding vector(1024), normalised_text, updated_at

item_aliases                   -- the compounding asset
  id, tenant_id, item_id, alias_text, source ('human'|'accepted_match'),
  hit_count, last_used_at
  UNIQUE (tenant_id, lower(alias_text))

price_rules
  id, tenant_id, scope ('contract'|'volume'|'segment'|'category'),
  customer_id nullable, item_id nullable, category nullable,
  min_qty, price_minor | margin_bps, valid_from, valid_to, priority
```

`tax_class` has **no default**. An item without one blocks invoicing. See `CLAUDE.md` non-negotiable 3.

## Quote to cash

```
rfqs
  id, tenant_id, customer_id nullable, source ('email'|'whatsapp'|'upload'|'manual'),
  raw_ref (R2 key), received_at, deadline_at, delivery_zone_id,
  extraction_status, extraction_confidence, assigned_user_id

rfq_lines
  id, rfq_id, line_no, raw_text, qty, uom, brand_hint, spec_notes,
  matched_item_id nullable, match_confidence, match_method, human_confirmed_at

quotes
  id, tenant_id, rfq_id nullable, customer_id, quote_no, version,
  status ('draft'|'sent'|'opened'|'accepted'|'rejected'|'expired'),
  subtotal_minor, tax_minor, total_minor, currency,
  valid_until, sent_at, first_opened_at, accepted_at,
  public_token, pdf_r2_key

quote_lines
  id, quote_id, item_id, qty, unit_price_minor, discount_bps,
  tax_class, line_total_minor,
  price_rule_id, price_explanation jsonb        -- which rule fired, and why

orders
  id, tenant_id, quote_id, customer_id, status, delivery_zone_id, promised_at

invoices
  id, tenant_id, order_id, customer_id, invoice_no,
  issue_date, due_date, subtotal_minor, tax_minor, total_minor,
  paid_minor, status ('draft'|'transmitting'|'issued'|'part_paid'|'paid'|'void'),
  etims_cuin, etims_qr_url, etims_transmitted_at, etims_error,
  pdf_r2_key

credit_notes
  id, tenant_id, invoice_id, reason, total_minor,
  etims_cuin, etims_transmitted_at
```

`invoices.status = 'issued'` **requires** a non-null `etims_cuin`. Enforce with a CHECK constraint, not application logic.

## Payments

```
payments
  id, tenant_id, channel ('mpesa_stk'|'mpesa_c2b'|'bank'|'cash'),
  amount_minor, currency, received_at,
  external_ref,                          -- M-Pesa receipt no.
  payer_phone_e164, payer_name_raw, narrative_raw,
  reconciliation_status ('unmatched'|'proposed'|'matched'|'split')

payment_allocations
  id, payment_id, invoice_id, amount_minor, confirmed_by_user_id, confirmed_at
```

Deliberately many-to-many. Kenyan B2B payers pay three invoices in one lump and one invoice in four instalments, routinely. A one-payment-one-invoice model will fail in week one.

## The outcome ledger

This is the table that makes the agents real. Without it, everything above is a CRUD app with a mailing list.

```
agent_runs
  id, tenant_id, agent_key, run_at, cadence_key,
  candidates_considered, actions_taken, policy_version, cost_minor

agent_actions
  id, run_id, tenant_id, agent_key, subject_type, subject_id,
  action_type, variant_id, channel,
  proposed_at, approved_by_user_id nullable, executed_at,
  payload_hash, cancelled_at

agent_outcomes
  id, action_id, tenant_id,
  outcome_type,                          -- 'quote_accepted' | 'invoice_paid' | 'replied' | 'no_response' | 'opted_out'
  outcome_at, value_minor,               -- money attributable, if any
  attribution_window_days, attribution_method ('direct'|'windowed')

agent_variants
  id, tenant_id, agent_key, variant_key, content_template,
  status ('candidate'|'active'|'retired'),
  sends, positive_outcomes, value_minor_total,
  created_at, retired_at, retired_reason
```

Every row in `agent_actions` must eventually acquire a row in `agent_outcomes` — including `no_response`, which is written by a sweeper when the attribution window closes. A missing outcome is a data bug, and it silently poisons the learning loop.

## Metering and billing

```
usage_events
  id, tenant_id, metric, quantity, occurred_at, unit_cost_minor, metadata
  metric ∈ rfq_parsed | quote_sent | invoice_transmitted
         | wa_template_sent | sms_sent | llm_tokens | payment_processed

subscriptions
  id, tenant_id, plan, status, current_period_start, current_period_end,
  billing_channel ('mpesa_ratiba'|'mpesa_manual'|'card'|'invoice'),
  mandate_ref, next_charge_at
```

Meter from day one even while everything is flat-rate. You cannot retrofit usage history, and without it you will price the product by guessing.

## Indexes worth naming now

- `rfq_lines (rfq_id, line_no)`
- `item_embeddings` HNSW on `embedding`
- `item_aliases (tenant_id, lower(alias_text))` unique
- `invoices (tenant_id, status, due_date)` — the dunning agent's hot path
- `payments (tenant_id, reconciliation_status, received_at)`
- `agent_actions (tenant_id, agent_key, executed_at)`
- Partial index on `outbox (state) WHERE state NOT IN ('sent','failed_permanent','cancelled')`
