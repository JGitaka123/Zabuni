# Zabuni — testing handover

**For:** James, Safuney Limited
**Date:** 2026-08-10

This is an early build. It covers the catalog foundation only: signing in, setting up your company, getting your product list in, classifying it for tax, and matching an RFQ line to a SKU. Quoting, invoicing, eTIMS, M-Pesa and the agents are not built yet — see [What is deliberately not here](#what-is-deliberately-not-here) so you are not hunting for something that does not exist.

Everything runs on your machine against a local database. Nothing contacts KRA, Safaricom, Meta or any email provider, and no real customer data should be entered.

## What you need

- Node.js 22, pnpm 9.15.9, Docker Desktop
- About 15 minutes for first-time setup

## Setting it up

```powershell
git clone https://github.com/JGitaka123/Zabuni.git
cd Zabuni
Copy-Item .env.example .env
docker compose -f infra/local/compose.yml up -d
pnpm install --frozen-lockfile
pnpm --filter @zabuni/db db:migrate
pnpm build
```

Then start the two services, each in its own terminal:

```powershell
pnpm --filter @zabuni/api start     # API on http://localhost:3001
pnpm --filter @zabuni/web dev       # dashboard on http://localhost:3000
```

Open http://localhost:3000/sign-in.

## Signing in

Sign-in uses a six-digit code sent to your email address. **No email is actually sent** in this build — there is no mail provider configured, and adding one before the data-protection work is done would be premature.

Instead, every code is written to a file in the project root:

```powershell
Get-Content fixture-otp.jsonl -Tail 1
```

That prints something like:

```json
{ "recipient": "james@safuney.co.ke", "code": "834247", "purpose": "sign-in", "sentAt": "..." }
```

Use that code on the sign-in screen. Any email address works — you do not need a real inbox. Codes expire after five minutes, and requesting more than three in quick succession is throttled on purpose; wait a minute and try again.

The code is deliberately **not** recoverable from the database: it is stored hashed, exactly as it would be in production. The file exists only because this build has no mail provider, and it can never appear in a real deployment — the service refuses to start in production with the fixture configuration.

The first time you sign in you will be asked for your company's legal name. That creates your tenant. Everything you do afterwards is scoped to it.

## What is worth testing

The value of your time is in the first three especially — they are where a bug costs real money or creates a legal problem.

1. **Your real SKU list.** Import a genuine export of your product list, however messy. Wrong column names, blank cells, duplicate codes, odd units, prices with decimals or currency symbols. The import previews before it commits: check that what it says it will create matches what you expect, and that it refuses the rows it should refuse.

2. **Tax classification.** Every item must carry an explicit KRA classification — 16% standard, zero-rated, or exempt — and a note recording why. The system will not let you create or import an item without one, and will not let you change one without a fresh note. This is intentional and it is the part most worth trying to break: if you find any route that lets an item exist without an explicit classification, that is the most important bug you can report.

3. **Matching.** Take real RFQ lines — how a customer actually writes them, abbreviations and all — and see which SKU comes back and why. Each result shows its component scores and the reasons behind it. Tell us where it is confidently wrong; that is more useful than where it is unsure.

4. **Money.** Costs are stored in cents and never as decimals. If you ever see a price render as `1234.5600000001`, or a total that is a cent out, we want to know immediately.

5. **Two-company isolation.** Sign in with a second email address, create a second company, and try hard to see the first one's data. You should not be able to. If you can, stop and tell us straight away.

## What is deliberately not here

None of this is missing by accident:

- **No quoting, invoicing, eTIMS, or M-Pesa.** Those are Phase 2. There is no way to raise an invoice yet.
- **No WhatsApp, no agents, no chasing of receivables.** Phase 3.
- **No RFQ upload or document extraction.** That is the next task (Q-4) and is blocked until matching is measured against a real held-out set of your RFQs — which is one of the things we would like from you.
- **The background worker will not start.** It refuses on purpose: it has no delivery handlers yet, and starting it against a real queue would mark every queued item as permanently failed. `worker_no_handlers_registered` in the log is the expected, correct behaviour.
- **Match quality is not representative.** The local matcher uses a deterministic stand-in, not a real embedding model. Judge the explanations and the workflow, not the accuracy.

## Reporting what you find

Please include:

- What you did, in the order you did it
- What you expected, and what happened
- The `correlationId` if an error message showed one — it ties directly to the server log
- The SKU, item code, or import file involved, where relevant

Anything touching **tax classification, money, or one company seeing another's data** is top priority. Send those the moment you see them rather than saving them up.

## Running the checks yourself

There is an automated pass of 100 scenarios against the running API:

```powershell
$env:TRUSTED_PROXY_IP_HEADER="x-forwarded-for"   # so the suite can act as distinct clients
pnpm --filter @zabuni/api start                   # in another terminal
pnpm acceptance
```

It should report `100/100 passed`. If it does not on a clean checkout, that is itself worth reporting. The most recent recorded run is in [`docs/reports/acceptance-2026-08-10.md`](./reports/acceptance-2026-08-10.md), including the four defects it caught.

## A note on your data

Please use a copy of your catalog rather than anything containing customer names, phone numbers or KRA PINs. The data-protection registration and the Kenya-region hosting decisions are not finished yet, so this build should not hold anything that matters under the Data Protection Act.
