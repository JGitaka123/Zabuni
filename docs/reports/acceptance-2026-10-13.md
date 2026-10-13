# Acceptance run — 2026-10-13

**Result: 113/113 passed**, stable across four consecutive runs, against a local
fixture-mode stack (Postgres 16 + pgvector, `INTEGRATION_MODE=fixture`).

Thirteen scenarios are new since the previous run, covering the defects below.

## What this pass found

A review of the catalog path — the only customer-facing surface that exists —
turned up seven defects. Six are fixed here, each with a test that fails
without the fix. The seventh -- an upload buffered into memory before its size
was checked -- was fixed in parallel on `main` while this work was in progress,
so only an end-to-end scenario proving the limit is wired into the running
server is added for it.

### 1. No real price list could be imported

`costMinor` accepted only integer minor units, so every shape a genuine export
contains was rejected: `1234.56`, `1,234.56`, `KSh 2500`, `1234.5`, `0.07`.
Q-1's acceptance criterion is "Safuney's real SKU list imports cleanly", and the
handover guide promised prices "with decimals or currency symbols" worked. They
did not. A distributor would have had to transform their spreadsheet into
integer cents before the importer would look at it.

Closed by a new mappable `cost` column and `parseMoneyAmount` in
`packages/core/money.ts`, which converts a written amount to exact minor units
by string arithmetic — no float is produced anywhere. The currency decides the
precision, which matters inside the stated footprint: UGX and RWF have no
decimal places, so reading "1500" in Kampala as fifteen shillings would have
been a hundredfold error. Anything that would require a guess is refused with a
reason instead of interpreted: `1.234,56` could be either convention, a comma
before two digits is a European decimal, and `1.005` in KES cannot be exact.

`costMinor` keeps its original meaning, and a row may map one or the other but
not both. Reinterpreting the existing column would have divided every stored
price by a hundred.

### 2. The sign-in codes were written where nobody was told to look

`pnpm --filter @zabuni/api start` runs with its working directory set to
`apps/api`, so the fixture mailbox landed at `apps/api/fixture-otp.jsonl` — not
beside the README, where the handover guide tells a tester to read it. Signing
in locally by following the written instructions was impossible.

This is the most embarrassing one: it meant the acceptance suite scored 24/100
on a clean checkout, because every scenario past sign-in cascaded from one
missing file. Relative mailbox paths now resolve against the repository root,
and the absolute path is logged at startup so it never has to be guessed again.

### 3. A shifted row was imported silently

CSV parsing runs with `relax_column_count`, and rows were mapped by header
position, so any cell beyond the last heading was discarded without a word. A
row shifted by one column imported a plausible-looking price against the wrong
SKU — and the preview the user is asked to check displayed the same wrong thing
the commit would write, which defeats the point of previewing.

The file is now refused, naming the row by the number the preview uses. An
empty overflow cell — a trailing comma — is still forgiven, because it carries
no value.

### 4. An oversized upload was buffered before being measured

Both upload routes called `parseBody()`, which reads the entire multipart body
into memory, and only then checked the 10 MB per-file cap. Any authenticated
user could exhaust the process heap with a single POST and never reach that
check.

Found independently here and on `main`, where the request-level body limit
landed first; that fix is the one in the tree. What is added here is scenario
112, which proves over real HTTP that the limit is actually wired into the
server a tester runs, and a specific response for a file that is inside the
request limit but over the per-file cap, which `/preview` had been reporting as
a column-mapping failure.

### 5. The item list was unbounded

Import accepts twenty thousand rows and `GET /catalog/items` returned all of
them in one response — a payload whose size the caller could not predict and
the server could not refuse. It is now paged on `limit`/`offset` with the same
ceiling as the alias listing, ordered by SKU then id so no row can repeat or be
skipped between pages, and reports `hasMore`. The dashboard follows the pages.

### 6. "Your file is wrong" carried no detail

Every file-level parse failure — a duplicate heading, a blank heading, a formula
cell, too many rows — collapsed into `catalog_validation_failed` with nothing
attached, leaving a tester no idea what to change. These messages describe the
user's own file and contain no internal detail, so they are now returned as
`catalog_file_invalid` with the message.

### 7. Prices were displayed as raw minor units

The dashboard rendered a 1,234.56 cost as `KES 123456`. Shown to a person that
reads as a hundredfold error, and it is exactly what a tester would report as a
money bug. `formatMinorUnits` renders the amount exactly, again by string
arithmetic.

## Known limitations, unchanged

- Match quality is not representative: the local matcher uses a deterministic
  stand-in, not a real embedding model. Q-3's ≥80% top-1 gate still needs a
  held-out Safuney RFQ set that does not exist in this repository.
- The worker refuses to start (`worker_no_handlers_registered`). Correct: it has
  no delivery handlers until E-3.
- Nothing contacts KRA, Safaricom, Meta or any mail provider.

## Two things that need a decision rather than a guess

- **A price list with no currency column.** A decimal cost needs its currency to
  know how many decimal places it has, so `cost` requires a mapped
  `costCurrency`. Most Kenyan price lists are single-currency and carry no such
  column. Declaring one currency for a whole import would fix that, but it is a
  product decision about money, so it is not invented here.
- **Partial commit.** One rejected row blocks the whole import, so a single bad
  cell in a twenty-thousand-row file means fixing the file and starting again.
  Committing the valid rows and listing the rest may be the better workflow, but
  that too is a product decision.

## Full scenario list

| #   | Area                           | Scenario                                                       | Result | Notes                                         |
| --- | ------------------------------ | -------------------------------------------------------------- | ------ | --------------------------------------------- |
| 1   | Operations and configuration   | GET /health returns ok                                         | pass   |                                               |
| 2   | Operations and configuration   | GET /ready confirms database connectivity                      | pass   |                                               |
| 3   | Operations and configuration   | health does not require authentication                         | pass   |                                               |
| 4   | Operations and configuration   | unknown route returns 404                                      | pass   |                                               |
| 5   | Operations and configuration   | health responds within 2s                                      | pass   | 1ms                                           |
| 6   | Operations and configuration   | readiness reports no internal detail                           | pass   |                                               |
| 7   | Operations and configuration   | removed phone OTP send endpoint is gone                        | pass   |                                               |
| 8   | Operations and configuration   | removed phone OTP verify endpoint is gone                      | pass   |                                               |
| 9   | Authentication                 | email OTP send succeeds for a new address                      | pass   |                                               |
| 10  | Authentication                 | delivered code is six digits                                   | pass   |                                               |
| 11  | Authentication                 | stored verification value is hashed, not the code              | pass   | verified separately against auth_verification |
| 12  | Authentication                 | sign-in with the delivered code succeeds                       | pass   |                                               |
| 13  | Authentication                 | session cookie is HttpOnly                                     | pass   |                                               |
| 14  | Authentication                 | session cookie is SameSite=Lax                                 | pass   |                                               |
| 15  | Authentication                 | wrong code is rejected                                         | pass   |                                               |
| 16  | Authentication                 | a code cannot be replayed after use                            | pass   |                                               |
| 17  | Authentication                 | malformed email is rejected                                    | pass   |                                               |
| 18  | Authentication                 | empty email is rejected                                        | pass   |                                               |
| 19  | Authentication                 | requesting a second code invalidates the first                 | pass   |                                               |
| 20  | Authentication                 | sign-in marks the identity email verified                      | pass   |                                               |
| 21  | Authentication                 | session endpoint returns the signed-in address                 | pass   |                                               |
| 22  | Authentication                 | no session returns null rather than an error                   | pass   |                                               |
| 23  | Authentication                 | a forged session cookie is rejected                            | pass   |                                               |
| 24  | Authentication                 | sign-out clears the session                                    | pass   |                                               |
| 25  | Authentication                 | OTP send is rate limited under rapid repetition                | pass   | 3 sent, 11 throttled                          |
| 26  | Onboarding and tenancy         | catalog is denied before onboarding                            | pass   |                                               |
| 27  | Onboarding and tenancy         | onboarding creates a tenant and returns owner role             | pass   |                                               |
| 28  | Onboarding and tenancy         | onboarding without a display name still succeeds               | pass   |                                               |
| 29  | Onboarding and tenancy         | blank legal name is rejected                                   | pass   |                                               |
| 30  | Onboarding and tenancy         | missing legal name is rejected                                 | pass   |                                               |
| 31  | Onboarding and tenancy         | onboarding requires authentication                             | pass   |                                               |
| 32  | Onboarding and tenancy         | a second onboarding for the same identity returns 409, not 500 | pass   |                                               |
| 33  | Onboarding and tenancy         | malformed onboarding JSON is rejected                          | pass   |                                               |
| 34  | Onboarding and tenancy         | over-long legal name is rejected                               | pass   |                                               |
| 35  | Onboarding and tenancy         | over-long display name is rejected                             | pass   |                                               |
| 36  | Onboarding and tenancy         | catalog becomes reachable after onboarding                     | pass   |                                               |
| 37  | Onboarding and tenancy         | session proof reports the tenant and role                      | pass   |                                               |
| 38  | Onboarding and tenancy         | a new tenant starts with an empty catalog                      | pass   |                                               |
| 39  | Catalog items                  | create an explicitly classified item                           | pass   |                                               |
| 40  | Catalog items                  | created item appears in the listing                            | pass   |                                               |
| 41  | Catalog items                  | cost is serialized as a string, never a float                  | pass   |                                               |
| 42  | Catalog items                  | duplicate SKU is refused                                       | pass   |                                               |
| 43  | Catalog items                  | duplicate SKU differing only in case is refused                | pass   |                                               |
| 44  | Catalog items                  | item creation requires authentication                          | pass   |                                               |
| 45  | Catalog items                  | blank SKU is rejected                                          | pass   |                                               |
| 46  | Catalog items                  | blank description is rejected                                  | pass   |                                               |
| 47  | Catalog items                  | non-numeric cost is rejected                                   | pass   |                                               |
| 48  | Catalog items                  | negative cost is rejected                                      | pass   |                                               |
| 49  | Catalog items                  | unknown currency is rejected                                   | pass   |                                               |
| 50  | Catalog items                  | control characters in description are rejected                 | pass   |                                               |
| 51  | Catalog items                  | update changes a mutable field                                 | pass   |                                               |
| 52  | Catalog items                  | update with an invalid item id is rejected                     | pass   |                                               |
| 53  | Catalog items                  | update of an unknown item returns 404                          | pass   |                                               |
| 54  | Catalog items                  | archive deactivates rather than deleting                       | pass   |                                               |
| 55  | Catalog items                  | archive with an invalid id is rejected                         | pass   |                                               |
| 56  | Catalog items                  | listing is ordered by SKU                                      | pass   |                                               |
| 57  | Catalog items                  | item ids are UUIDv7                                            | pass   |                                               |
| 58  | Catalog items                  | created timestamp is ISO-8601 UTC                              | pass   |                                               |
| 59  | Tax classification             | item without a tax class is blocked                            | pass   |                                               |
| 60  | Tax classification             | the blocking message names tax classification                  | pass   |                                               |
| 61  | Tax classification             | tax class without an audit basis is blocked                    | pass   |                                               |
| 62  | Tax classification             | blank audit basis is blocked                                   | pass   |                                               |
| 63  | Tax classification             | an unknown tax class is rejected                               | pass   |                                               |
| 64  | Tax classification             | zero-rated is accepted                                         | pass   |                                               |
| 65  | Tax classification             | exempt is accepted                                             | pass   |                                               |
| 66  | Tax classification             | reclassification requires a basis note                         | pass   |                                               |
| 67  | Tax classification             | reclassification with a basis succeeds                         | pass   |                                               |
| 68  | Tax classification             | reclassifying to the same class is refused                     | pass   |                                               |
| 69  | Tax classification             | reclassifying an unknown item returns 404                      | pass   |                                               |
| 70  | Tax classification             | an invalid tax class on reclassify is rejected                 | pass   |                                               |
| 71  | Catalog import                 | CSV preview validates and stages                               | pass   |                                               |
| 72  | Catalog import                 | preview reports the source headers                             | pass   |                                               |
| 73  | Catalog import                 | a row with no description is rejected                          | pass   |                                               |
| 74  | Catalog import                 | a row with no tax class is staged, not silently defaulted      | pass   |                                               |
| 75  | Catalog import                 | commit creates the previewed items                             | pass   |                                               |
| 76  | Catalog import                 | re-committing reports not-ready rather than not-found          | pass   |                                               |
| 77  | Catalog import                 | committing an unknown import returns 404                       | pass   |                                               |
| 78  | Catalog import                 | an import containing an invalid row cannot commit              | pass   |                                               |
| 79  | Catalog import                 | an unsupported file type is refused                            | pass   |                                               |
| 80  | Catalog import                 | a preview without a mapping is refused                         | pass   |                                               |
| 81  | Catalog import                 | import preview requires authentication                         | pass   |                                               |
| 82  | Catalog import                 | an invalid import id is rejected before lookup                 | pass   |                                               |
| 83  | Matching and aliases           | embedding generation succeeds for an item                      | pass   |                                               |
| 84  | Matching and aliases           | matching returns candidates with component scores              | pass   | 3 candidates                                  |
| 85  | Matching and aliases           | matching reports the normalized query                          | pass   |                                               |
| 86  | Matching and aliases           | matching names the matcher version                             | pass   |                                               |
| 87  | Matching and aliases           | an empty query is rejected                                     | pass   |                                               |
| 88  | Matching and aliases           | a missing query field is rejected                              | pass   |                                               |
| 89  | Matching and aliases           | an out-of-range limit is rejected                              | pass   |                                               |
| 90  | Matching and aliases           | matching requires authentication                               | pass   |                                               |
| 91  | Matching and aliases           | aliases can be listed                                          | pass   |                                               |
| 92  | Matching and aliases           | a blank alias is rejected                                      | pass   |                                               |
| 93  | Security, limits and isolation | a second tenant can onboard independently                      | pass   |                                               |
| 94  | Security, limits and isolation | a second tenant cannot see the first tenant's items            | pass   |                                               |
| 95  | Security, limits and isolation | a second tenant cannot fetch the first tenant's item by id     | pass   |                                               |
| 96  | Security, limits and isolation | a second tenant's match returns no foreign candidates          | pass   |                                               |
| 97  | Security, limits and isolation | a disallowed CORS origin is not echoed back                    | pass   |                                               |
| 98  | Security, limits and isolation | an oversized JSON body is refused                              | pass   |                                               |
| 99  | Security, limits and isolation | match requests are rate limited per user                       | pass   | 29 ok, 7 limited                              |
| 100 | Security, limits and isolation | no response leaks database or stack detail                     | pass   |                                               |
| 101 | Real-world prices and paging   | a decimal price list imports and converts exactly              | pass   |                                               |
| 102 | Real-world prices and paging   | a price in another currency is refused, not rescaled           | pass   |                                               |
| 103 | Real-world prices and paging   | an ambiguous European price is refused with an explanation     | pass   |                                               |
| 104 | Real-world prices and paging   | a price with more precision than the currency is refused       | pass   |                                               |
| 105 | Real-world prices and paging   | a row with more values than headings is refused outright       | pass   |                                               |
| 106 | Real-world prices and paging   | a decimal cost is accepted on the item API too                 | pass   |                                               |
| 107 | Real-world prices and paging   | giving both a decimal cost and minor units is refused          | pass   |                                               |
| 108 | Real-world prices and paging   | the item list is paged and reports whether more remain         | pass   |                                               |
| 109 | Real-world prices and paging   | a page beyond the catalog is empty rather than an error        | pass   |                                               |
| 110 | Real-world prices and paging   | an out-of-range page is rejected                               | pass   |                                               |
| 111 | Real-world prices and paging   | paging never repeats or skips an item                          | pass   | 7 on the first page                           |
| 112 | Real-world prices and paging   | an oversized upload is refused rather than buffered            | pass   |                                               |
| 113 | Real-world prices and paging   | the fixture mailbox sits where the handover says it does       | pass   | fixture-otp.jsonl                             |
