# 01 — Product Specification

## Ideal customer profile

**Primary:** Kenyan B2B distributors of consumable goods, 5–60 staff, KES 20M–500M annual turnover, VAT-registered.

Verticals, in priority order:
1. Hygiene, janitorial and PPE supply (Safuney's own category — we have insider knowledge)
2. Medical and laboratory consumables
3. Agro-inputs (seed, agrochemicals, veterinary)
4. Industrial and food-service chemicals
5. Office and educational supplies

**Qualifying signals:** issues more than 20 quotes/month; sells on 30–90 day credit terms; has a SKU price list in Excel; already struggling with eTIMS; has at least one person whose job is partly "chasing payments."

**Disqualifying signals:** retail/B2C, single-SKU manufacturers, businesses under the VAT threshold, anyone whose sales are cash-on-delivery (no receivables = half the product is dead weight).

## The five people who touch it

| Role | What they need | Where they are |
|---|---|---|
| **Sales rep** | Turn an RFQ into a quote in minutes, from a phone | WhatsApp + mobile web |
| **Sales manager** | See quote pipeline, win rate, who's slow | Desktop dashboard |
| **Finance/accounts** | Compliant invoices, clean reconciliation, DSO down | Desktop |
| **Owner/MD** | Cash position, margin, is compliance handled | Weekly digest, mobile |
| **The buyer** (their customer) | A clear quote, an invoice they can claim, an easy way to pay | Email + WhatsApp + link |

That last row matters more than it looks. See `docs/09` on the buyer-side network effect.

## Scope: what Zabuni does

### Module 1 — Intake

Ingests RFQs from four channels into one queue:

- **Email** — a dedicated per-tenant address (`rfq@{tenant}.zabuni.co.ke`) plus optional Gmail/Outlook OAuth forwarding
- **WhatsApp** — inbound to the tenant's WhatsApp Business number
- **Upload** — drag a PDF/Excel/photo into the dashboard
- **Manual** — type it in

Handles the real-world formats: PDF tender schedules, Excel BOQs, Word tables, plain-text email bodies, and — critically — **photographs of printed RFQs**, which is how a large share arrive in Kenya.

Extraction uses Claude with vision. Output is a structured line-item set: description, quantity, unit, brand hint, specification notes, delivery location, deadline. Every extracted field carries a confidence score. Anything below threshold is surfaced for human confirmation rather than silently guessed.

**Acceptance:** a photo of a 20-line printed RFQ produces a correctly structured line-item set with per-field confidence, in under 30 seconds.

### Module 2 — Catalog and matching

The tenant's SKUs, with: description, brand, pack size, unit of measure, cost, price tiers, **KRA tax classification**, HS code (optional), lead time, stock position, substitutes.

The hard problem is **matching**: an RFQ says "hand wash 5L" and the catalog has "Safuney Antibacterial Hand Soap, 5L jerrican, ANT-HW-5000." A hybrid matcher does this — pgvector embedding similarity over normalised descriptions, plus lexical scoring on pack size and unit, plus a per-tenant learned alias table that grows every time a human corrects a match.

That alias table is a compounding asset. It is the reason a tenant who has used Zabuni for a year gets faster, better quotes than a new one — and the reason leaving hurts. Treat it as a first-class product surface, not an implementation detail.

**Acceptance:** after 200 corrected matches, top-1 match accuracy on that tenant's recurring RFQ vocabulary exceeds 90%.

### Module 3 — Pricing engine

Deterministic, auditable, never LLM-decided. Rules, in evaluation order:

1. Contract price (customer-specific agreed rate, if any)
2. Volume tier price
3. Customer segment price list
4. Cost + target margin, floored at a per-category minimum margin
5. Manual override — always allowed, always logged with a reason

Plus: currency handling for imported goods (USD cost, KES sell, FX buffer), lead-time surcharge, and delivery cost by zone.

The engine emits a **price explanation** for every line — which rule fired and why. Sales reps must be able to defend a number to a customer. LLM-generated pricing would make that impossible and is forbidden.

### Module 4 — Quote

Produces a branded PDF and a shareable web link. Contains line items, prices, validity period, lead times, payment terms, and the tenant's compliance details.

Quote features that actually drive win rate:
- **Read receipts** on the web link — you know when the buyer opened it
- **Buyer-side accept** — one click converts quote to order
- **Variants** — good/better/best or alternate brand at different price points, generated in one pass
- **Follow-up cadence** — automatic, tapering, killable (this is Agent 1)

**Acceptance:** median RFQ-to-quote-sent time under 15 minutes, measured end to end.

### Module 5 — Order and eTIMS invoice

Accepted quote → sales order → delivery note → tax invoice.

The invoice is transmitted to KRA eTIMS via VSCU/OSCU API and must come back with a Control Unit Invoice Number and QR code before it is considered issued. See `docs/05`.

Credit notes, cancellations and corrections follow KRA's rules strictly: no amendment without prior cancellation, no reprint without a "Copy" watermark, no invoice line without an identified good or service.

**Acceptance:** invoice transmitted, CUIN and QR returned and rendered, verifiable on KRA's portal. Failed transmissions appear as an actionable incident within 60 seconds.

### Module 6 — Collections

Payment channels:
- **M-Pesa STK push** from the invoice link (Daraja)
- **M-Pesa paybill/till** with automatic C2B reconciliation against invoice references
- **Bank transfer** with manual or statement-import matching

Reconciliation is fuzzy and forgiving — Kenyan B2B payers routinely pay partial amounts, pay against the wrong reference, or pay three invoices in one lump. The matcher must handle all three and propose splits for human confirmation.

Then the dunning ladder — this is Agent 2, and it is where the money is.

### Module 7 — Restock

For repeat consumable accounts, models consumption from order history, predicts depletion date per customer per SKU, and generates a proactive restock offer. This is Agent 3.

### Module 8 — Insight

Owner-facing weekly digest: cash collected, DSO, quote win rate, margin by category, top slow payers, agent performance. Delivered by WhatsApp and email, not buried in a dashboard nobody opens.

## Explicitly out of scope (v1)

- Full accounting/GL — we integrate, we don't replace. Export to QuickBooks/Sage/Odoo.
- Inventory management with warehouse locations and bin picking.
- Native mobile apps. WhatsApp plus responsive web is the mobile strategy.
- Procurement/buy-side workflows.
- Multi-country tax engines. Kenya only in v1; Tanzania and Uganda are a v2 decision, not a v1 abstraction. **Do not build a generic tax abstraction layer for hypothetical countries.** It will be the wrong abstraction and it will cost you two months.

## Interface direction

Two surfaces, deliberately different in character.

**The dashboard** is a working instrument, not a marketing page. Dense, fast, keyboard-navigable. The design reference is a trading terminal or an airline ops screen — people use this eight hours a day and want information density over whitespace. Tabular data is the hero. Type is a compact grotesque for UI with tabular-figure numerals throughout; every column of money must align on the decimal.

**The buyer-facing quote and invoice** is the opposite: it is the only thing your customer's customer ever sees, it must look more credible than a Word document emailed as PDF, and it carries the tenant's brand, not ours. Generous, calm, single-column, printable, and legible on a cracked phone screen in bright sun — which is the actual viewing condition. High contrast, large type, no thin greys.

Signature element: the **quote timeline** — a single horizontal strip on every quote and invoice showing RFQ received → quoted → opened → accepted → invoiced → paid, with real timestamps. Visible to both the tenant and the buyer. It makes the product's core promise, speed, into something you can see, and it quietly pressures the buyer at the "opened but not accepted" stage.
