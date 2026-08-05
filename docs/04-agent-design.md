# 04 — Agent Design

## The contract

An agent in Zabuni satisfies four conditions. Anything missing one is a scheduled job with better marketing, and must not be called an agent in the UI or the pitch.

1. **Unified data.** It reads the full tenant state — catalog, customers, quotes, invoices, payments, message history — not a single table.
2. **Cadence.** It runs on a schedule, unprompted.
3. **Reads results back.** Every action it takes acquires an attributable outcome, and those outcomes change its future behaviour.
4. **Honest, fast signal.** The outcome is unambiguous, arrives within a usable window, and cannot be gamed by the agent itself.

Condition 4 is the one that gets skipped and it is the one that decides whether an agent is worth building. Before adding any new agent, answer in writing: *how many days until the outcome lands, and can the agent make itself look good without creating value?* If the loop is slower than ~30 days or the signal is a proxy the agent can inflate, build a tool instead and say so.

## The three v1 agents

### Agent 1 — Quote follow-up

**Cadence:** daily, 09:00 Africa/Nairobi, business days.
**Population:** quotes with status `sent` or `opened`, not expired, not accepted.
**Actions:** send a follow-up on the customer's preferred channel; mark cold; notify the rep to call.
**Signal:** `quote_accepted` (positive, value = quote total), `rejected`, `no_response` at expiry.
**Loop speed:** 3–21 days. Acceptable.

Learns: which follow-up timing and framing converts, per customer segment. A hospital procurement office and a hotel F&B manager respond to different cadences; the agent finds that rather than being told.

An **opened but not accepted** quote is the highest-value signal in the product. Prioritise it.

### Agent 2 — Receivables

This is the revenue agent. Build it second, but it is what sells the product.

**Cadence:** daily, 08:30, business days. Never weekends. Never public holidays — maintain a Kenyan holiday calendar; dunning on Madaraka Day is a relationship cost with no upside.
**Population:** invoices with `status ∈ (issued, part_paid)` and `due_date` within the ladder window.

**The ladder** (default; tenant-configurable):

| Stage | Timing | Channel | Tone | Approval |
|---|---|---|---|---|
| Pre-due courtesy | due − 3d | WhatsApp utility | Informational, includes pay link | Auto |
| Due today | due day | WhatsApp utility | Neutral reminder | Auto |
| Gentle | due + 7d | WhatsApp + email | Friendly, assumes oversight | Auto |
| Firm | due + 21d | Email to AP + WhatsApp | Direct, states terms | Auto below threshold |
| Escalation | due + 45d | Email cc'd to owner | Formal, references terms | **Human approval always** |
| Hold | due + 60d | Internal task | Suspend credit, rep calls | **Human approval always** |

**Signal:** `invoice_paid` or partial payment within a 7-day attribution window of the action. Value = amount received. This is the cleanest signal in the entire product — it is money, it arrives in days, and the agent cannot fake it.

**Timing intelligence:** learn per-customer payment behaviour. Many Kenyan SMEs pay in predictable windows tied to their own receipts and to month-end. An agent that nudges two days before a customer's habitual payment day materially outperforms one that nudges on a fixed calendar. This is a genuine, defensible learned asset and it is invisible to competitors.

**Hard constraints:**
- Never state or imply legal action, credit blacklisting, or CRB listing. Not in any variant, ever. Add a prohibited-phrase validator that blocks the send and raises an incident.
- Never contact anyone but the designated AP contacts on file.
- Instant, honoured opt-out on every channel.
- Tenant kill switch pauses all outbound within 60 seconds.
- If a payment lands mid-ladder, cancel every queued action for that invoice **before** the next send. A dunning message to someone who paid yesterday costs more trust than the invoice is worth.

### Agent 3 — Restock

**Cadence:** weekly, Monday 07:00.
**Population:** customers with ≥3 orders of a consumable SKU.
**Model:** per customer per SKU, estimate consumption rate from order interval and quantity, predict depletion, act at a configurable lead-time offset.
**Action:** draft a restock offer with a one-click quote-accept link. Requires rep approval for the first eight weeks per tenant, then auto below a value threshold.
**Signal:** `quote_accepted` within 14 days. Value = order total.
**Loop speed:** 14–45 days. Slowest of the three, so expect it to learn slowest. Set expectations accordingly.

## What is NOT an agent

Be honest in the product and the pitch:

- **RFQ extraction** — a tool. No cadence, no learning loop.
- **eTIMS transmission** — infrastructure. Must be boring.
- **The weekly digest** — a report.

Calling these agents is the exact hype Cody was drawing a line against. It also sets a bar you'll then fail to clear on the ones that matter.

## The learning loop

```
propose → guardrail → (approve?) → execute → observe → attribute → update policy
```

**Variant selection.** Each agent holds a pool of `agent_variants`. Selection is Thompson sampling over a Beta posterior on positive-outcome rate, per (agent, customer segment, ladder stage).

**The sample-size guardrail — read this twice.** A Kenyan distributor's addressable list is hundreds of customers, not millions. An agent optimising on 40 sends is optimising on noise, and it will confidently converge on a bad variant and burn the list.

Therefore:
- No variant is retired below **60 sends** in its cell.
- No variant is promoted to default below **100 sends** and a posterior probability of superiority above 0.9.
- Cells with fewer than 60 sends fall back to the tenant's default variant, not to exploration.
- Below **200 total sends**, a tenant runs the global prior learned across all tenants rather than its own — this is a real cross-tenant advantage and one of our moats, but it must be aggregate-only. Never leak one tenant's content or customer data into another's pool.

**Policy versioning.** Every `agent_run` records `policy_version`. When a policy changes, the version increments and the change is visible in the tenant's audit log. A customer must be able to ask "why did it send that?" and get an answer.

## Guardrails, non-negotiable

| Guardrail | Rule |
|---|---|
| Approval threshold | Per tenant, per agent, in KES. Above it, human confirms. Default is low. |
| Frequency cap | Max 1 outbound per customer contact per 48h across all agents, combined. Agents share the cap. |
| Quiet hours | No sends outside 08:00–18:00 Africa/Nairobi, business days only. |
| Prohibited content | Validator blocks legal threats, CRB references, guilt language, false urgency. Blocking is a hard fail, not a warning. |
| Opt-out | Honoured within one run cycle, across every channel and every agent. |
| Kill switch | Tenant-level, one click, effective within 60 seconds, cancels queued outbox rows. |
| Cost cap | Per-tenant monthly ceiling on message and inference spend. Halt and notify, never silently overspend. |

## Evaluation

Agents ship with an offline eval before they touch a customer:

- **Extraction eval:** 200 labelled real RFQs (from Safuney's archive), scored on line-item F1 and field accuracy. Gate: ≥0.9 F1 before production.
- **Matching eval:** held-out corrected matches, top-1 and top-3 accuracy.
- **Dunning eval:** cannot be evaluated offline against ground truth — there is no counterfactual. Instead run a **holdout**: 15% of eligible invoices get the tenant's pre-Zabuni manual process. Report the delta honestly, including when it is unflattering. This holdout is also the single most persuasive artefact in your sales deck, so protect its integrity.
