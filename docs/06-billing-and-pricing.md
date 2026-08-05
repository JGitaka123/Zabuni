# 06 — Billing and Pricing

## Pricing principle

Price against the **outcome**, anchored on the **compliance requirement**, metered on **messages and inference**.

Kenyan SMEs benchmark software against what they already pay: an ERP seat, a bulk SMS bundle, an accountant's monthly retainer. Anchoring on "AI software" invites a comparison to free chatbots. Anchoring on "eTIMS compliance + collections" invites a comparison to a KES 1M penalty and to KES 3M sitting in overdue receivables. Anchor deliberately.

## Tiers

All in KES, monthly, VAT exclusive. Annual prepay −15%.

| | **Starter** | **Growth** | **Scale** |
|---|---|---|---|
| **Price/mo** | 12,000 | 38,000 | 95,000 |
| Users | 3 | 10 | Unlimited |
| RFQs parsed | 50 | 250 | 1,000 |
| Quotes | Unlimited | Unlimited | Unlimited |
| eTIMS invoices | 200 | 1,000 | Unlimited |
| WhatsApp messages included | 500 | 2,500 | 8,000 |
| Quote follow-up agent | ✓ | ✓ | ✓ |
| Receivables agent | — | ✓ | ✓ |
| Restock agent | — | ✓ | ✓ |
| Buyer portal | — | ✓ | ✓ |
| Accounting export | ✓ | ✓ | ✓ |
| API access | — | — | ✓ |
| Multi-branch | — | — | ✓ |
| Support | Email | WhatsApp, next day | Named contact |

**Overages:** RFQ parse KES 40 · eTIMS invoice KES 12 · WhatsApp utility KES 2.50 · WhatsApp marketing KES 9.

Note the WhatsApp markup: ~3× Meta's utility rate (~KES 0.80) and ~1.7× marketing (~KES 5.20). This must remain a healthy margin after the 1 October 2026 repricing makes service replies chargeable. Re-model in September 2026.

**Onboarding fee: KES 45,000**, waived on annual prepay. Covers catalog import, tax classification of the SKU list, eTIMS connection, and template approval. Charge it. It filters tyre-kickers, funds the genuinely expensive part of onboarding, and a distributor who won't pay 45k for setup will not pay 38k monthly either.

### Deliberate tier design

The **receivables agent sits behind Growth**. It is the highest-value module and the strongest upgrade lever — a Starter tenant watching their DSO stay flat while the product tells them what a collections agent would recover is the cleanest upsell in the business. Starter exists to get them compliant and hooked, not to be a good deal.

### On success fees

Tempting: "we take 2% of what we recover." Do not do it in v1.

- It implies debt-collection agency activity, which is a licensed and reputationally loaded category in Kenya.
- Attribution disputes are inevitable — the customer will insist they'd have paid anyway, and sometimes they're right.
- It makes revenue lumpy and unforecastable, which kills your ability to plan spend.

Use the **holdout data** from `docs/04` to justify a fixed price instead. "Invoices in our agent cohort were paid 19 days faster than your holdout" sells a subscription without any of the above.

## Billing collection — the actual hard part

Recurring billing in Kenya is genuinely difficult. There is no equivalent of card-on-file that most SMEs will accept.

**Three channels, in order of preference:**

1. **M-Pesa Ratiba (standing order)** — Safaricom's standing-order product via Daraja. Customer authorises a recurring debit once. Closest thing to a real mandate. **Verify current Ratiba API capability, B2B eligibility, mandate limits and failure semantics before committing** — this is the highest-uncertainty item in the billing design and it determines your churn mechanics.
2. **Card via Paystack** — works for the more formalised tenants, fails for many SMEs.
3. **Invoice + STK push reminder** — fallback and default for larger accounts. Zabuni raises its own eTIMS-compliant invoice (we must be compliant too), then dunning runs on our own agent. Eating our own dog food here is both efficient and an unusually honest sales artefact.

**Dunning our own customers:** same ladder as `docs/04`, gentler. Grace period 14 days, then read-only mode — never delete data, never block eTIMS transmission of invoices already in flight. Locking a customer out of tax compliance over a billing dispute is a reputational catastrophe in a market this small.

**Failed-payment recovery:** retry Ratiba on days 1, 3, 7. Then a human calls. In this market a phone call recovers more than any automated sequence, and the account sizes justify it.

## Unit economics (per Growth tenant, monthly)

**Revenue:** KES 38,000

**Direct costs:**

| Item | Estimate | Notes |
|---|---|---|
| WhatsApp messages (2,500 incl.) | 2,600 | Utility-weighted; rises after Oct 2026 |
| LLM inference | 2,400 | 250 RFQ parses + drafting; Haiku-first, cached catalog |
| Infra share (DB, Redis, R2, compute) | 1,100 | |
| eTIMS/Daraja | ~0 | No per-transaction fee |
| Support allocation | 3,500 | The real cost; falls with product maturity |
| **Total COGS** | **~9,600** | |

**Gross margin ≈ 75%.** Acceptable for African B2B SaaS, and it improves as the alias table matures (fewer LLM calls per RFQ) and support load drops.

**Watch items:** inference cost is the lever most likely to drift — cache the catalog context aggressively. Support is the cost most likely to be underestimated; every hour of onboarding hand-holding is real money and it is why the onboarding fee exists.

**Targets:** CAC under KES 90,000 (see `docs/07`), payback under 4 months, gross logo churn under 2%/month. The compliance dependency should make churn structurally low — a tenant who leaves has to solve eTIMS again from scratch.

## Metering implementation

Meter everything from commit one, even while all plans are flat. Write a `usage_events` row for every RFQ parse, invoice transmission, message send, and LLM call, with the unit cost at time of use. Aggregate nightly into a per-tenant cost view visible to us internally.

Without this you cannot answer "is this customer profitable?", and in a usage-heavy AI product that question arrives sooner than you expect.

Tenants see their own usage against plan limits in-app, with a projection. Never surprise a customer with an overage — warn at 80% and again at 100%, and make upgrading a single click at that moment.
