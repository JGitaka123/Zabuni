# 05 — Integrations

Version-dated as of **August 2026**. These APIs move. Re-verify against primary sources before implementing, and update this file in the same PR when reality differs.

---

## 1. KRA eTIMS — the wedge

### What it is

The Electronic Tax Invoice Management System. Since January 2024, mandatory for all Kenyan taxpayers — including non-VAT-registered traders and professionals. Every sale must be invoiced through an eTIMS channel.

**The 2026 escalation, which is our entire go-to-market:** from 1 January 2026, KRA's Income and Expense Validation Engine automatically cross-checks every income and expense entry in a tax return against eTIMS invoice data. Any expense without a valid eTIMS invoice is non-deductible. Penalties reach KES 1 million or 10% of the tax involved.

This means a distributor's **customers** now audit them. Non-compliant invoices don't just risk the distributor's own penalty — they make the buyer's expense claim fail, which loses the account. That is a far stronger purchase driver than "save time on quotes."

### Integration modes

KRA provides two system-to-system paths:

- **OSCU** (Online Sales Control Unit) — for invoicing systems that operate online continuously. **This is ours.** Zabuni is a cloud SaaS; OSCU is the natural fit.
- **VSCU** (Virtual Sales Control Unit) — for bulk invoicing systems that are not always online, typically POS estates and branch operations.

Support OSCU in v1. Design the client interface so VSCU can be added without restructuring, but do not implement it speculatively.

### Certification — start this in week one

Anyone undertaking self-integration or acting as a third-party vendor **must complete KRA's certification process before commencing integration**. This is a gating dependency with an external, unpredictable lead time. It is the single most likely cause of schedule slip in this project.

Action: begin certification immediately, in parallel with all other work. Do not sequence it after the build.

Also decide early: does each tenant self-integrate under their own credentials with Zabuni as the invoicing system, or does Zabuni become a certified third-party vendor transmitting on their behalf? The second is a much stronger moat and a much heavier compliance obligation. Get written guidance from KRA rather than inferring — and get it before writing the client.

### Required invoice fields

At minimum: seller and buyer identification (KRA PIN), per-line description, quantity, unit price, and **tax classification** (standard 16% / zero-rated / exempt). KRA returns a **Control Unit Invoice Number (CUIN)** and a **QR code**, both of which must appear on the printed or rendered invoice. Buyers scan the QR to verify authenticity on KRA's portal.

### Behavioural rules to encode

These come from the eTIMS specification and are frequent sources of rejection:

- A transaction cannot be registered without identifying the good or service.
- A transaction cannot be corrected without cancelling the original first.
- Only one original receipt may be printed. Reprints carry a "Copy" watermark.
- A receipt cannot be issued for goods where stock is below the requested quantity.

Encode all four as invariants in `packages/etims`, not as UI hints.

### The most common failure

**Incorrect tax classification of goods and services.** This is why `items.tax_class` has no default and blocks invoicing when absent. A silent 16% default would ship a compliance product that quietly creates the exact liability it claims to remove.

### Client design

```
packages/etims
  ├─ client.ts          OSCU transport, auth, retry, circuit breaker
  ├─ invariants.ts      the four behavioural rules, as guards
  ├─ mapping.ts         Zabuni invoice → eTIMS payload
  ├─ fixtures/          recorded responses incl. every error code
  └─ errors.ts          typed error taxonomy → tenant-readable messages
```

Every transmission: outbox row, idempotency key, terminal state, tenant-visible incident on permanent failure. A CUIN is required before `invoices.status = 'issued'` — enforced by CHECK constraint.

Error messages must be translated into something a Kenyan finance officer can act on. "Item tax classification invalid on line 4 — set a tax class for SKU ANT-HW-5000" beats a KRA error code, and this translation layer is quietly a large part of what customers are paying for.

---

## 2. M-Pesa — Daraja API

### Current state

Daraja is Safaricom's official M-Pesa API. **Daraja 3.0 launched November 2025** — cloud-native, improved reliability, faster onboarding, new security APIs. No gateway fee beyond standard Safaricom transaction rates.

Products we use:

| Product | Use in Zabuni |
|---|---|
| **STK Push** (Lipa na M-Pesa Online) | Pay-now button on quote and invoice links |
| **C2B** | Paybill/till deposits with validation + confirmation callbacks — the main collection path |
| **Transaction Status / Account Balance** | Reconciliation and treasury views |
| **M-Pesa Ratiba** (standing orders) | Subscription billing — see `docs/06` |
| **B2C** | Refunds and credit-note settlements (v2) |

### Onboarding reality

Going live requires a Head Office paybill/till, a bank account letter, signed authorisation forms, and a "Go Live" application on the Daraja portal. Lead time is measured in weeks, not days.

**Start the Safaricom paperwork the same week you start the eTIMS certification.** Both are external-dependency long poles.

Guidance in the market is that below ~KES 300,000/month in processed volume, an aggregator (Paystack, Kopo Kopo, Tingg, Jenga, Equity's gateway) is worth the fee versus direct Daraja hassle. For Zabuni, tenants collect under *their own* paybill, so we are integrating on their behalf rather than processing centrally — which avoids us becoming a payment aggregator and the CBK licensing question that comes with it.

**Do not hold customer funds. Do not net payments through a Zabuni account.** The moment money flows through us, we are a payments business requiring CBK authorisation. Design so funds move directly from the buyer to the tenant's own paybill and Zabuni only observes the callback.

### Reconciliation

The hard part, and where most Kenyan B2B tools fail. Build for:

- Partial payments against one invoice
- One payment covering several invoices
- Wrong or missing account references (extremely common)
- Payer name mismatch between M-Pesa registration and the customer record
- Duplicate callbacks — Daraja retries; dedupe on `TransactionID`
- Late callbacks arriving after manual reconciliation

The matcher scores candidates on amount, reference substring, payer phone against `customer_contacts`, and timing proximity to an invoice due date. Above a confidence threshold it auto-allocates; below, it proposes a split for one-click human confirmation. Never auto-allocate a payment it cannot explain.

**Callback handling:** verify, persist raw, enqueue, return 200 fast. Never process inline.

---

## 3. WhatsApp Cloud API

### Why WhatsApp is the channel

Over 96% of Kenyan internet users use WhatsApp daily. For B2B collections and quotes, it is where the AP clerk actually reads messages. Email is secondary. SMS is fallback.

Meta retired the On-Premise API in October 2025. Use **Cloud API** only.

### Pricing — and a change that lands in two months

Meta moved to **per-message pricing on 1 July 2025**. Charged per delivered template message, by category and recipient country. Approximate Kenya rates as of mid-2026:

| Category | Approx. cost | Use |
|---|---|---|
| Marketing | ~KES 5.20 | Restock offers, promotions |
| Utility | ~KES 0.80 | Invoice reminders, quote sent, payment receipts |
| Authentication | ~KES 0.50 | Login OTP |
| Service (reply in 24h window) | Free — **until 1 Oct 2026** | Conversational replies |

**Critical, and it must shape the v1 design:** from **1 October 2026**, service replies inside the 24-hour customer-service window become chargeable, billed at the market's utility/authentication rate, and utility messages sent in response to users inside that window also become chargeable. The "free conversation window" strategy that every WhatsApp playbook written before mid-2026 relies on is expiring.

Design consequences:
1. **Never build unit economics on free service messages.** Model every outbound message as billable from day one.
2. **Route ruthlessly by category.** A dunning reminder is a *utility* template at ~KES 0.80, not a marketing template at ~KES 5.20 — a 6.5× difference on the highest-volume message in the product. Category is set by the template, not the content. Getting this wrong is the fastest way to destroy gross margin.
3. **Cap conversational turns.** An AI agent chatting freely in the service window is now a per-message cost line. Bound it and hand off to a human after N turns.
4. **Meter and pass through.** Message cost is a metered line item, not something we absorb. See `docs/06`.

### Templates are a human-speed bottleneck

Every business-initiated message needs a Meta-approved template. Approval takes hours to days and can be rejected. An agent that generates infinite message variants is worthless if each variant needs approval.

**Therefore: pre-approved template library with variable slots.** The agent selects among approved templates and fills variables; it does not author free-form business-initiated text. Variant experimentation happens *within* the approved template set. This constraint is non-obvious and it invalidates a naive port of a Facebook-ads-style creative loop — plan for it in the schema (`agent_variants.content_template` maps to a Meta template ID, not raw text).

### Compliance

- Opt-in required before any template send. Store `wa_opt_in_at`. No opt-in, no send — enforced in code, not policy.
- Honour opt-out immediately across all agents.
- Quality rating: Meta throttles and can ban numbers with poor rating. Monitor via webhook, alert on any drop, and auto-pause marketing templates for a tenant whose rating degrades. A banned number is an outage for that tenant.

### Also worth knowing

Click-to-WhatsApp ads connect Facebook/Instagram campaigns directly to a WhatsApp conversation — relevant to `docs/07`, because it lets paid acquisition land in the channel Kenyan SMEs actually use rather than a web form they abandon.

---

## 4. Email

**Inbound:** per-tenant address `rfq@{tenant}.zabuni.co.ke` via Postmark or Cloudflare Email Routing → webhook. Parse MIME, store attachments to R2, enqueue extraction. Optional Gmail/Microsoft OAuth for tenants who prefer forwarding from an existing address.

**Outbound:** Resend or Postmark. Separate sending domains for transactional (quotes, invoices) and agent (follow-ups, dunning) so a deliverability problem in one cannot take down the other. SPF, DKIM, DMARC on both, per-tenant custom domain where they want it.

---

## 5. Anthropic API

`@anthropic-ai/sdk`. Model selection per `docs/02`. Requirements:

- Schema-validated structured output on every call; one retry then human escalation
- Prompt caching on the catalog context — this is the largest single inference cost lever
- Token and cost logging attributed per tenant, per task
- Vision for photographed RFQs (a large share of real intake)
- Redact phone numbers and KRA PINs before they enter a prompt
- Circuit breaker: on sustained API failure, degrade to manual entry with a clear UI state rather than queueing indefinitely

---

## Integration risk summary

| Dependency | Failure mode | Mitigation |
|---|---|---|
| eTIMS certification | Blocks launch entirely | Start week 1, in parallel |
| eTIMS uptime | Invoices stuck | Outbox + retries + visible incidents + manual fallback path |
| Daraja go-live | Blocks collection | Start week 1; fixture mode keeps dev unblocked |
| Daraja sandbox instability | Dev blocked | Full fixture mode, never depend on sandbox |
| WhatsApp template rejection | Agent silent | Pre-approved library, ≥2 approved variants per stage |
| WhatsApp Oct 2026 repricing | Margin erosion | Priced in from day one; utility-first routing |
| WhatsApp number ban | Tenant outage | Quality monitoring, auto-pause, SMS/email fallback |
| LLM cost drift | Margin erosion | Per-tenant metering, caching, Haiku-first, hard caps |
