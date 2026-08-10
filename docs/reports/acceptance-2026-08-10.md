# Acceptance report — pre-handover to Safuney

**Date:** 2026-08-10
**Build:** `main` plus the email-auth and hardening changes on `claude/zabuni-review-enhance-4mcsff`
**Mode:** `INTEGRATION_MODE=fixture`, no network, local PostgreSQL 16 with pgvector
**Suite:** `pnpm acceptance` (`test/acceptance/run.mjs`), 100 scenarios driven over HTTP

## Result

100 of 100 scenarios pass, on four consecutive runs. The repository gates pass alongside it: typecheck 13/13, lint 8/8, 201 unit and integration tests, build 8/8.

These scenarios exercise the running service over HTTP, which is deliberately different from the unit and integration suites: every defect listed below was invisible in-process and only appeared once the application was actually run.

## Defects found and fixed during this pass

### 1. Onboarding failed outright after the switch to email sign-in

`app.provision_tenant_owner` copied `auth_identity.name` straight into `users.name`. The phone plugin filled that in via `getTempName`; email sign-in leaves it empty, and `users_name_not_blank` rejects a blank. The first action a new tenant took returned a 500.

Migration `0019` now resolves the owner's display name explicitly, falling back to the identity name and then the email local part, and `/onboarding` accepts an optional `fullName`.

### 2. Authentication rate limiting was configured but never ran

Better Auth resolves the client only from headers and skips limiting entirely when it cannot (`if (!ip) return`). Behind `@hono/node-server` with no proxy header that is every request, so `auth_rate_limit` stayed empty and one-time-code sending was unthrottled — an email-bombing and enumeration vector.

The API now resolves the caller itself, honouring a forwarded header only when the deployment declares one via `TRUSTED_PROXY_IP_HEADER`, since an untrusted header lets a caller choose its own bucket. When no address can be determined, everyone shares one bucket rather than none: fail closed. Sending is now throttled after three requests per window, verified live.

### 3. Duplicate onboarding returned a server error

`provision_tenant_owner` signals refusals with SQLSTATEs, which `/onboarding` did not map. A double-clicked form returned `500 internal_error` rather than "you already have a tenant". It now returns 409 `tenant_already_provisioned`, and 403 or 400 for the other refusals.

### 4. Roughly 2% of concurrent requests returned an empty 500

Under about 25 parallel requests, a few would return HTTP 500 with an empty body and **no server-side log at all**. Reproduced at 3–5 failures per 150 requests.

The request logger runs after the response is settled, so a throw there escapes past `onError` and the server adapter answers with an empty 500 — and because the logger is what failed, nothing records why. Pino raises `EAGAIN` when writing to a saturated pipe, which is exactly the condition a burst creates.

Telemetry can no longer fail a request: the log and capture calls are isolated, so a dropped log line costs a log line rather than a customer's request. Verified at 0 failures per 400 concurrent requests, against 3–5 before. **This defect predates this work** — it reproduces identically on unmodified `main`.

## Scenario results

| #   | Area                           | Scenario                                                       | Result | Notes                                         |
| --- | ------------------------------ | -------------------------------------------------------------- | ------ | --------------------------------------------- |
| 1   | Operations and configuration   | GET /health returns ok                                         | pass   |                                               |
| 2   | Operations and configuration   | GET /ready confirms database connectivity                      | pass   |                                               |
| 3   | Operations and configuration   | health does not require authentication                         | pass   |                                               |
| 4   | Operations and configuration   | unknown route returns 404                                      | pass   |                                               |
| 5   | Operations and configuration   | health responds within 2s                                      | pass   | 2ms                                           |
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

## Known limitations, unchanged by this run

- Phase 2 onward is not built. There is no eTIMS transmission, no M-Pesa, no WhatsApp, and no agent runtime. The outbox worker refuses to start because no delivery handler exists yet.
- Q-4 (RFQ intake) has not started. Q-3 is engineering-complete but not accepted: the ≥80% top-1 accuracy gate needs a held-out Safuney RFQ set that does not exist in this repository.
- The fixture embedding provider is deterministic and local. Match quality here says nothing about production quality, which depends on an embedding provider that has not been chosen.
- GitHub Actions are pinned by tag rather than commit SHA.
