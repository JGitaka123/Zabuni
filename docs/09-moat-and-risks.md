# 09 — Moat and Risks

## Moat, honestly assessed

Rated by how hard each is for a competitor to copy, and how long it takes.

### 1. eTIMS certification and reliability — **strong, immediate**

Certification is a gated regulatory process with real lead time. Beyond the certificate, the durable part is the accumulated handling of KRA's error taxonomy: every rejection code translated into something a finance officer can act on, every edge case in cancellation and correction encoded. That knowledge only comes from running production volume through a flaky government API.

The market already knows to distrust bolt-on eTIMS support — buyers are being advised to demand a live demonstration before purchasing. Being demonstrably solid here is a defensible position, not just a feature.

**Decay risk:** medium. KRA could simplify. More vendors will certify over time. Treat this as the wedge that buys you time to build 2–4, not as the permanent moat.

### 2. Per-tenant learned assets — **strong, compounds slowly**

Three things that only exist after months of use:

- **The alias table** — the tenant's own RFQ vocabulary mapped to their SKUs. A year in, quoting is materially faster and more accurate than day one. Leaving means starting cold.
- **The payer behaviour model** — when each customer actually pays, and what nudge works on them. Invisible to competitors and impossible to buy.
- **Price and win/loss history** — what was quoted, at what margin, and whether it won.

This is the real moat. It is why the product must be instrumented from commit one, and why `agent_outcomes` is non-negotiable.

**Decay risk:** low. It is genuinely proprietary and genuinely useful.

### 3. Cross-tenant priors — **moderate, and it is a scale advantage**

New tenants inherit aggregate learned priors on dunning timing and follow-up cadence, so they perform above cold-start from week one. Every tenant makes the next one better. This is a real network effect on the supply side and it strengthens with scale.

Must be **aggregate only** — never one tenant's content, customers or prices in another's pool. Audit this. A leak here is company-ending in a market where distributors know each other.

### 4. Buyer-side pull — **potentially the strongest, unproven**

Every quote and invoice reaches a buyer. Buyers who like the experience — clear quotes, verifiable invoices, one-tap M-Pesa payment, one portal for all their suppliers — start asking their *other* suppliers to use it. That is demand-side distribution you don't pay for.

This is the highest-ceiling moat in the plan and also the most speculative. Build the buyer portal properly in Phase 4 and measure whether inbound referrals actually materialise. Don't assume it; test it.

### What is NOT a moat

Be honest with yourselves:

- **LLM-powered RFQ extraction.** Commoditising fast. A competitor replicates it in a month.
- **Quote PDFs, invoicing UI, M-Pesa integration.** All table stakes.
- **"AI agents."** A positioning claim, not a defence.

Do not build the pitch deck around these.

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | eTIMS certification takes far longer than planned | High | Blocks launch | Start day one; build everything else against fixtures; have a manual-entry fallback that keeps the product usable |
| R2 | KRA changes eTIMS spec mid-build | Medium | Rework | Isolate in `packages/etims`; version the mapping layer |
| R3 | An ERP incumbent ships good native eTIMS + adds agents | Medium | Erodes wedge | Our ICP is too small for enterprise ERP economics. Stay in the 5–60 staff band where they don't want to compete. |
| R4 | WhatsApp Oct 2026 repricing compresses margin | **Certain** | Margin | Already modelled. Utility-first routing. Re-price September 2026. |
| R5 | WhatsApp number ban from poor quality rating | Medium | Tenant outage | Quality monitoring, auto-pause marketing on degradation, SMS/email fallback |
| R6 | Distributors won't pay KES 38k/month | Medium | Kills the model | Test with paying design partners in Phase 1, before scaling. If three warm, well-qualified prospects all refuse, the price or the ICP is wrong — find out at three, not thirty. |
| R7 | Onboarding is too heavy to scale | **High** | Caps growth | Onboarding fee funds it; invest in LLM-assisted classification; track time-to-first-invoice as a hard metric |
| R8 | Agent sends something that damages a tenant's customer relationship | Medium | **Severe, reputational** | Prohibited-content validator, conservative approval thresholds, kill switch, mid-ladder cancellation on payment. Treat one bad send as a P1 incident. |
| R9 | Cross-tenant data leak | Low | **Company-ending** | RLS + mandatory cross-tenant tests in CI + aggregate-only priors + audit |
| R10 | LLM cost drift destroys gross margin | Medium | Margin | Per-tenant metering from day one, caching, Haiku-first, hard caps |
| R11 | Building for Safuney produces something only Safuney wants | **High** | Wasted quarter | Phase 1 design partners are in *adjacent* categories deliberately. Any feature Safuney requests that doesn't generalise goes in a config, not the core. |
| R12 | Labpoint takes custom consulting work to survive, starving the build | High | Delay | Budget the runway explicitly. Decide up front what fraction of capacity is defended for Zabuni and hold the line. |
| R13 | Data protection non-compliance (DPA 2019) | Medium | Legal, reputational | ODPC registration before tenant two; minimal PII; redaction; documented transfer basis |
| R14 | We accidentally become a payments business | Low | Regulatory | Never hold or net customer funds. Money moves buyer → tenant paybill directly. Zabuni only observes callbacks. |

## Kill criteria

Decide these now, while it costs nothing to be honest. Revisit at each phase gate.

**Kill or pivot if:**

- After Phase 1, Safuney's median RFQ-to-quote time has not fallen by at least half. The core promise doesn't work.
- After Phase 3, the receivables agent shows no DSO improvement against the holdout. The value proposition is imaginary.
- Three qualified design partners in a row refuse to pay a Growth-tier price. The economics don't support the build.
- eTIMS certification is still unresolved at month 6. The wedge is closed and the whole positioning needs rebuilding.

**Sunk cost is not a reason to continue.** Write these down now, because in month seven you will want to argue with them.

## The three things that matter most

If everything else in these documents is executed badly but these three are right, this works:

1. **eTIMS transmission is boringly, provably reliable.** It is the reason they buy and the reason they stay.
2. **Every agent action acquires an honest outcome.** Without this the learning loop is theatre and the moat never forms.
3. **Two numbers, measured continuously from day one: quote latency and DSO.** They are simultaneously the product, the case study, the ad creative and the renewal argument.
