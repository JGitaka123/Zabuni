# 10 — Codex Kickoff

## Before you paste anything

1. Push the repo with `README.md`, `CLAUDE.md`, `AGENTS.md` and `docs/` — **and nothing else.** No scaffold, no `package.json`. Codex does better generating a coherent monorepo from scratch than patching one it didn't design.
2. Confirm `AGENTS.md` is at the repo root. Codex looks for it there.
3. Point Codex at the repo and give it write access to a branch, not `main`.

Run the kickoff prompt once. Then use the per-task template for everything after.

---

## Kickoff prompt — copy from here

> You are the founding engineer on Zabuni, a multi-tenant SaaS for East African B2B distributors: RFQ intake → quoting → KRA eTIMS-compliant invoicing → M-Pesa collection → autonomous receivables agents.
>
> The repository currently contains specification documents only. There is no code. Your job in this task is **Phase 0 — Foundation** and nothing beyond it.
>
> **Step 1 — Read, then plan before writing any code.**
>
> Read in this order: `AGENTS.md`, `CLAUDE.md`, `docs/08-build-plan.md`, `docs/02-architecture.md`, `docs/03-data-model.md`. Skim `docs/01-product-spec.md` for context.
>
> Then write your implementation plan to `docs/plans/phase-0.md` and **stop for my review before writing application code.** The plan must include: the exact package layout you will create, the libraries and versions you have chosen with one line of justification each, the migration order, how you will structure the RLS policies and the test that proves them, and every place where you found the specs ambiguous or contradictory. Do not resolve ambiguities on your own — list them as questions.
>
> **Step 2 — after I approve the plan, implement Phase 0 tasks F-1 through F-7** exactly as scoped in `docs/08-build-plan.md`. One commit per task ID, in order.
>
> **Scope boundary.** Phase 0 ships nothing customer-facing. No quote builder, no eTIMS client, no WhatsApp, no agents, no UI beyond a bare authenticated shell that proves the session sets `app.tenant_id`. If you find yourself writing business logic, you have left the phase — stop.
>
> **Hard requirements, in priority order. These are correctness, not style:**
>
> 1. **Row-Level Security is real and proven.** Every tenant-owned table has RLS enabled, the application database role has no `BYPASSRLS`, and `app.tenant_id` is set from the verified session at the start of every transaction. Ship a test that creates two tenants with data and proves tenant A cannot read tenant B's rows *through the ORM*, not just through raw SQL. This test is the single most important artefact of Phase 0.
> 2. **Money is `bigint` minor units plus an ISO-4217 code.** Implement `Money` in `packages/core/money.ts` with exhaustive unit tests covering addition, allocation/splitting with remainder distribution, percentage application, and rounding. Floats are forbidden anywhere near currency. There must be no code path where a price becomes a `number`.
> 3. **`items.tax_class` has no default and is `NOT NULL`.** Add the schema and the CHECK constraint now, in Phase 0, even though invoicing arrives in Phase 2. Read `docs/05-integrations.md` on why silently defaulting to 16% would make this a compliance product that manufactures the exact liability it claims to remove.
> 4. **The outbox pattern works under failure.** Generic outbox table plus a drain worker with idempotency keys, exponential backoff, and terminal states. Prove it with a test that simulates a flaky external call and asserts exactly-once effect and no stuck rows.
> 5. **Per-tenant cost metering exists from the first commit.** A `usage_events` row is written for any metered action. Demonstrate it end to end with one synthetic event. This cannot be retrofitted and without it the product cannot be priced.
> 6. **Everything runs offline.** `INTEGRATION_MODE=fixture` is the default. No test may touch the network. Timezone logic uses `Africa/Nairobi` for business days; storage is UTC.
>
> **Stack** is specified in `CLAUDE.md`. Follow it. If you believe a choice there is wrong, raise it in the plan — do not silently substitute.
>
> **Definition of done:** from a clean clone, `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass with no network access, the cross-tenant RLS test is green, and `README.md` has a working local setup section you have actually followed yourself.
>
> **Do not:** add a vector database (pgvector only), add a second datastore, build a mobile app, create abstractions for countries other than Kenya, or invent product behaviour to resolve an ambiguity. When the specs are unclear, ask.
>
> Start with Step 1. Write the plan and stop.

## — copy to here

---

## Per-task template, for everything after Phase 0

> Task: **{ID}** from `docs/08-build-plan.md`.
>
> Read `AGENTS.md`, `CLAUDE.md`, the build-plan row for {ID}, and {the relevant doc}. Implement only {ID}.
>
> Acceptance criteria are the "Done when" column for {ID}. Treat them literally.
>
> Constraints: no network — use fixtures. No changes outside the scope of {ID}. Migrations forward-only. If {ID} touches money, tax classification, dunning content, or anything sent to a tenant's customer, add tests demonstrating the new behaviour before you consider it done.
>
> If you hit an ambiguity in the spec, stop and ask rather than choosing. If you find a bug outside {ID}, note it in the PR description and leave it alone.
>
> Use the PR description format in `AGENTS.md`. Fill in "Spec deviations" and "Open questions" honestly — an empty answer on a large change tells me you didn't check.

---

## Prompts that need extra care

Four tasks carry legal or reputational cost that code review will not catch. For these, add this paragraph to the per-task prompt:

> This task touches an area where a plausible-looking wrong answer is expensive. Do not infer behaviour from convention or from what similar products do. Where `docs/` does not specify, ask. Where `docs/` does specify, follow it exactly even if it seems overly strict — the strictness is deliberate and the reasoning is in the doc.

Apply it to:

- **Q-2, Q-6** — tax classification and the pricing engine. Wrong output here costs the tenant money or creates a KRA liability.
- **E-1 through E-5** — eTIMS. Read `docs/05-integrations.md` fully first. The four behavioural invariants are non-negotiable and each needs a test proving it blocks the violation.
- **A-2, A-6** — guardrails and the receivables ladder. A single badly-worded dunning message damages a tenant's customer relationship permanently. The prohibited-content validator is a hard fail, never a warning.
- **M-6** — cross-tenant priors. Aggregate only. A leak between tenants is company-ending in a market where distributors know each other by name.

## Working rhythm

- **One task per session.** Long multi-task sessions drift from the spec and produce PRs too large to review honestly.
- **Review the plan, not just the diff.** Most bad outcomes are visible in the plan and invisible in the code.
- **Keep `docs/` current.** If reality contradicts a spec — and it will, especially on eTIMS and Daraja — the doc gets updated in the same PR. Stale specs are worse than no specs, because agents follow them confidently.
- **Re-read `docs/09-moat-and-risks.md` at every phase gate.** The kill criteria are there for the month when you will want to argue with them.
