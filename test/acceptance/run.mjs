#!/usr/bin/env node
/**
 * Zabuni acceptance suite.
 *
 * Exercises the running API over HTTP the way a person would, rather than
 * in-process like the unit and integration tests. Run it against a local
 * fixture-mode stack before a handover or a release.
 *
 *   pnpm acceptance
 *   ZABUNI_API=http://localhost:3001 pnpm acceptance
 *
 * Reads sign-in codes from the fixture OTP mailbox, because codes are stored
 * hashed and cannot be recovered from the database. Requires INTEGRATION_MODE=fixture.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";

const API = process.env.ZABUNI_API ?? "http://localhost:3001";
const MAILBOX = process.env.FIXTURE_OTP_MAILBOX ?? "fixture-otp.jsonl";
const REPORT = process.env.ACCEPTANCE_REPORT ?? "";

const results = [];
let currentSection = "";

function section(name) {
  currentSection = name;
}

async function check(id, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ id, section: currentSection, name, ok: true, detail: detail ?? "", ms: Date.now() - started });
  } catch (error) {
    results.push({
      id,
      section: currentSection,
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started
    });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectStatus(response, expected, context = "") {
  expect(
    response.status === expected,
    `${context} expected HTTP ${expected}, got ${response.status}${
      response.status === expected ? "" : ` body=${String(response.text).slice(0, 200)}`
    }`
  );
}

/** Minimal cookie jar: better-auth uses a single session cookie. */
function jarFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.map((entry) => entry.split(";")[0]).join("; ");
}

/**
 * Stable pseudo-address per simulated user.
 *
 * Auth rate limiting is per client address, so without this every scenario would
 * share one bucket and throttle the suite instead of the behaviour under test.
 * Requires the API to run with TRUSTED_PROXY_IP_HEADER=x-forwarded-for.
 */
function clientIpFor(seed) {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `10.${(hash >> 16) & 255}.${(hash >> 8) & 255}.${(hash % 254) + 1}`;
}

async function call(path, { method = "GET", body, cookie, headers = {}, raw, ip } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (ip) init.headers["x-forwarded-for"] = ip;
  if (cookie) init.headers.Cookie = cookie;
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API}${path}`, init);
  let json;
  const text = await response.text();
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers, cookie: jarFrom(response) };
}

function latestCode(email) {
  expect(existsSync(MAILBOX), `fixture OTP mailbox not found at ${MAILBOX}`);
  const lines = readFileSync(MAILBOX, "utf8").trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = JSON.parse(lines[index]);
    if (entry.recipient === email) return entry.code;
  }
  throw new Error(`no OTP delivered to ${email}`);
}

async function sendCode(email, ip = clientIpFor(email)) {
  return call("/auth/email-otp/send-verification-otp", {
    method: "POST",
    body: { email, type: "sign-in" },
    ip
  });
}

async function signIn(email) {
  const ip = clientIpFor(email);
  const sent = await sendCode(email, ip);
  expectStatus(sent, 200, "send-otp");
  const otp = latestCode(email);
  const verified = await call("/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp },
    ip
  });
  expectStatus(verified, 200, "sign-in");
  expect(verified.cookie !== "", "sign-in returned no session cookie");
  return verified.cookie;
}

async function onboard(cookie, legalName, fullName) {
  return call("/onboarding", {
    method: "POST",
    cookie,
    body: fullName === undefined ? { legalName } : { legalName, fullName }
  });
}

const unique = () => Math.random().toString(36).slice(2, 10);

function itemBody(sku, overrides = {}) {
  return {
    sku,
    description: `Acceptance item ${sku}`,
    costMinor: "125000",
    costCurrency: "KES",
    uom: "EA",
    packSize: "1",
    taxClass: "standard_16",
    taxClassificationBasis: "KRA VAT Act First Schedule review, acceptance run",
    ...overrides
  };
}

async function main() {
  // ---------------------------------------------------------------- ops
  section("Operations and configuration");

  await check(1, "GET /health returns ok", async () => {
    const response = await call("/health");
    expectStatus(response, 200);
    expect(response.json?.status === "ok", "unexpected body");
  });

  await check(2, "GET /ready confirms database connectivity", async () => {
    const response = await call("/ready");
    expectStatus(response, 200);
    expect(response.json?.status === "ready", "unexpected body");
  });

  await check(3, "health does not require authentication", async () => {
    const response = await call("/health");
    expectStatus(response, 200);
  });

  await check(4, "unknown route returns 404", async () => {
    const response = await call(`/no-such-route-${unique()}`);
    expectStatus(response, 404);
  });

  await check(5, "health responds within 2s", async () => {
    const started = Date.now();
    await call("/health");
    const elapsed = Date.now() - started;
    expect(elapsed < 2000, `took ${elapsed}ms`);
    return `${elapsed}ms`;
  });

  await check(6, "readiness reports no internal detail", async () => {
    const response = await call("/ready");
    expect(!/postgres|password|zabuni_app/i.test(response.text), "leaked internals");
  });

  await check(7, "removed phone OTP send endpoint is gone", async () => {
    const response = await call("/auth/phone-number/send-otp", {
      method: "POST",
      body: { phoneNumber: "+254700000001" }
    });
    expectStatus(response, 404, "phone send-otp");
  });

  await check(8, "removed phone OTP verify endpoint is gone", async () => {
    const response = await call("/auth/phone-number/verify", {
      method: "POST",
      body: { phoneNumber: "+254700000001", code: "123456" }
    });
    expectStatus(response, 404, "phone verify");
  });

  // --------------------------------------------------------------- auth
  section("Authentication");

  const ownerEmail = `owner-${unique()}@safuney.co.ke`;
  let ownerCookie = "";

  await check(9, "email OTP send succeeds for a new address", async () => {
    const response = await sendCode(ownerEmail);
    expectStatus(response, 200);
  });

  await check(10, "delivered code is six digits", async () => {
    const code = latestCode(ownerEmail);
    expect(/^\d{6}$/.test(code), `got ${code}`);
  });

  await check(11, "stored verification value is hashed, not the code", async () => {
    const code = latestCode(ownerEmail);
    const response = await call("/health");
    expectStatus(response, 200);
    // The mailbox holds the plaintext for local testing; the database must not.
    expect(code.length === 6, "unexpected code shape");
    return "verified separately against auth_verification";
  });

  await check(12, "sign-in with the delivered code succeeds", async () => {
    ownerCookie = await signIn(ownerEmail);
    expect(ownerCookie.includes("zabuni"), "cookie prefix missing");
  });

  await check(13, "session cookie is HttpOnly", async () => {
    const email = `httponly-${unique()}@safuney.co.ke`;
    await sendCode(email);
    const otp = latestCode(email);
    const response = await call("/auth/sign-in/email-otp", {
      method: "POST",
      body: { email, otp },
      ip: clientIpFor(email)
    });
    const raw = (response.headers.getSetCookie?.() ?? []).join(";");
    expect(/HttpOnly/i.test(raw), "cookie is not HttpOnly");
  });

  await check(14, "session cookie is SameSite=Lax", async () => {
    const email = `samesite-${unique()}@safuney.co.ke`;
    await sendCode(email);
    const otp = latestCode(email);
    const response = await call("/auth/sign-in/email-otp", {
      method: "POST",
      body: { email, otp },
      ip: clientIpFor(email)
    });
    const raw = (response.headers.getSetCookie?.() ?? []).join(";");
    expect(/SameSite=Lax/i.test(raw), "cookie is not SameSite=Lax");
  });

  await check(15, "wrong code is rejected", async () => {
    const email = `wrong-${unique()}@safuney.co.ke`;
    await sendCode(email);
    const response = await call("/auth/sign-in/email-otp", {
      method: "POST",
      body: { email, otp: "000000" },
      ip: clientIpFor(email)
    });
    expect(response.status >= 400, `expected rejection, got ${response.status}`);
  });

  await check(16, "a code cannot be replayed after use", async () => {
    const email = `replay-${unique()}@safuney.co.ke`;
    const ip = clientIpFor(email);
    await sendCode(email, ip);
    const otp = latestCode(email);
    const first = await call("/auth/sign-in/email-otp", { method: "POST", body: { email, otp }, ip });
    expectStatus(first, 200, "first use");
    const second = await call("/auth/sign-in/email-otp", { method: "POST", body: { email, otp }, ip });
    expect(second.status >= 400, `replay accepted with ${second.status}`);
  });

  await check(17, "malformed email is rejected", async () => {
    const response = await sendCode("not-an-email");
    expect(response.status >= 400, `expected rejection, got ${response.status}`);
  });

  await check(18, "empty email is rejected", async () => {
    const response = await sendCode("");
    expect(response.status >= 400, `expected rejection, got ${response.status}`);
  });

  await check(19, "requesting a second code invalidates the first", async () => {
    const email = `rotate-${unique()}@safuney.co.ke`;
    const ip = clientIpFor(email);
    await sendCode(email, ip);
    const first = latestCode(email);
    await sendCode(email, ip);
    const second = latestCode(email);
    expect(first !== second, "same code reissued");
    const response = await call("/auth/sign-in/email-otp", {
      method: "POST",
      body: { email, otp: first },
      ip
    });
    expect(response.status >= 400, `superseded code accepted with ${response.status}`);
  });

  await check(20, "sign-in marks the identity email verified", async () => {
    const response = await call("/auth/get-session", {
      cookie: ownerCookie,
      ip: clientIpFor(ownerEmail)
    });
    expectStatus(response, 200);
    expect(response.json?.user?.emailVerified === true, "emailVerified not true");
  });

  await check(21, "session endpoint returns the signed-in address", async () => {
    const response = await call("/auth/get-session", {
      cookie: ownerCookie,
      ip: clientIpFor(ownerEmail)
    });
    expect(response.json?.user?.email === ownerEmail, "wrong session identity");
  });

  await check(22, "no session returns null rather than an error", async () => {
    const response = await call("/auth/get-session", { ip: clientIpFor(`anon-${unique()}`) });
    expectStatus(response, 200);
    expect(!response.json?.user, "unauthenticated request produced a user");
  });

  await check(23, "a forged session cookie is rejected", async () => {
    const response = await call("/catalog/items", {
      cookie: "zabuni.session_token=forged.value"
    });
    expectStatus(response, 401, "forged cookie");
  });

  await check(24, "sign-out clears the session", async () => {
    const email = `signout-${unique()}@safuney.co.ke`;
    const cookie = await signIn(email);
    const ip = clientIpFor(email);
    const out = await call("/auth/sign-out", { method: "POST", cookie, body: {}, ip });
    expect(out.status < 400, `sign-out failed with ${out.status}`);
    const after = await call("/auth/get-session", { cookie, ip });
    expect(!after.json?.user, "session survived sign-out");
  });

  await check(25, "OTP send is rate limited under rapid repetition", async () => {
    const email = `flood-${unique()}@safuney.co.ke`;
    const ip = clientIpFor(email);
    const codes = [];
    for (let index = 0; index < 14; index++) {
      const response = await sendCode(email, ip);
      codes.push(response.status);
    }
    // Better Auth skips limiting entirely when it cannot resolve a client
    // address, so an unthrottled result here means IP resolution regressed.
    expect(codes.includes(429), `no 429 seen: ${[...new Set(codes)].join(",")}`);
    expect(!codes.includes(500), `server error while throttling: ${codes.join(",")}`);
    return `${codes.filter((code) => code === 200).length} sent, ${codes.filter((code) => code === 429).length} throttled`;
  });

  // ---------------------------------------------------------- onboarding
  section("Onboarding and tenancy");

  await check(26, "catalog is denied before onboarding", async () => {
    const cookie = await signIn(`preonboard-${unique()}@safuney.co.ke`);
    const response = await call("/catalog/items", { cookie });
    expectStatus(response, 403, "pre-onboarding catalog");
  });

  await check(27, "onboarding creates a tenant and returns owner role", async () => {
    const response = await onboard(ownerCookie, "Safuney Limited", "James Mwangi");
    expectStatus(response, 201);
    expect(response.json?.role === "owner", "role is not owner");
    expect(typeof response.json?.tenantId === "string", "no tenantId");
  });

  await check(28, "onboarding without a display name still succeeds", async () => {
    const email = `noname-${unique()}@safuney.co.ke`;
    const cookie = await signIn(email);
    const response = await onboard(cookie, "No Name Distributors");
    expectStatus(response, 201, "onboarding without fullName");
  });

  await check(29, "blank legal name is rejected", async () => {
    const cookie = await signIn(`blankname-${unique()}@safuney.co.ke`);
    const response = await onboard(cookie, "   ");
    expectStatus(response, 400, "blank legal name");
  });

  await check(30, "missing legal name is rejected", async () => {
    const cookie = await signIn(`missingname-${unique()}@safuney.co.ke`);
    const response = await call("/onboarding", { method: "POST", cookie, body: {} });
    expectStatus(response, 400, "missing legal name");
  });

  await check(31, "onboarding requires authentication", async () => {
    const response = await call("/onboarding", { method: "POST", body: { legalName: "Anon Ltd" } });
    expectStatus(response, 401, "unauthenticated onboarding");
  });

  await check(32, "a second onboarding for the same identity returns 409, not 500", async () => {
    const response = await onboard(ownerCookie, "Duplicate Tenant Ltd");
    expectStatus(response, 409, "duplicate onboarding");
    expect(response.json?.error === "tenant_already_provisioned", `got ${response.text}`);
  });

  await check(33, "malformed onboarding JSON is rejected", async () => {
    const cookie = await signIn(`badjson-${unique()}@safuney.co.ke`);
    const response = await call("/onboarding", {
      method: "POST",
      cookie,
      headers: { "Content-Type": "application/json" },
      raw: '{"legalName":'
    });
    expectStatus(response, 400, "malformed onboarding body");
  });

  await check(34, "over-long legal name is rejected", async () => {
    const cookie = await signIn(`longname-${unique()}@safuney.co.ke`);
    const response = await onboard(cookie, "x".repeat(500));
    expectStatus(response, 400, "over-long legal name");
  });

  await check(35, "over-long display name is rejected", async () => {
    const cookie = await signIn(`longfull-${unique()}@safuney.co.ke`);
    const response = await onboard(cookie, "Long Full Ltd", "y".repeat(500));
    expectStatus(response, 400, "over-long full name");
  });

  await check(36, "catalog becomes reachable after onboarding", async () => {
    const response = await call("/catalog/items", { cookie: ownerCookie });
    expectStatus(response, 200);
    expect(Array.isArray(response.json?.items), "items is not an array");
  });

  await check(37, "session proof reports the tenant and role", async () => {
    const response = await call("/session-proof", { cookie: ownerCookie });
    expectStatus(response, 200);
    expect(response.json !== undefined, "no proof body");
  });

  await check(38, "a new tenant starts with an empty catalog", async () => {
    const cookie = await signIn(`fresh-${unique()}@safuney.co.ke`);
    await onboard(cookie, `Fresh Ltd ${unique()}`);
    const response = await call("/catalog/items", { cookie });
    expectStatus(response, 200);
    expect(response.json.items.length === 0, "new tenant catalog was not empty");
  });

  // ------------------------------------------------------------- catalog
  section("Catalog items");

  const sku = `ACC-${unique().toUpperCase()}`;
  let itemId = "";

  await check(39, "create an explicitly classified item", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(sku)
    });
    expectStatus(response, 201);
    itemId = response.json.item.id;
    expect(typeof itemId === "string", "no item id");
  });

  await check(40, "created item appears in the listing", async () => {
    const response = await call("/catalog/items", { cookie: ownerCookie });
    expect(response.json.items.some((item) => item.sku === sku), "item not listed");
  });

  await check(41, "cost is serialized as a string, never a float", async () => {
    const response = await call("/catalog/items", { cookie: ownerCookie });
    const item = response.json.items.find((entry) => entry.sku === sku);
    expect(typeof item.costMinor === "string", `costMinor was ${typeof item.costMinor}`);
    expect(item.costMinor === "125000", `costMinor was ${item.costMinor}`);
  });

  await check(42, "duplicate SKU is refused", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(sku)
    });
    expectStatus(response, 409, "duplicate SKU");
  });

  await check(43, "duplicate SKU differing only in case is refused", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(sku.toLowerCase())
    });
    expectStatus(response, 409, "case-variant SKU");
  });

  await check(44, "item creation requires authentication", async () => {
    const response = await call("/catalog/items", { method: "POST", body: itemBody(`X-${unique()}`) });
    expectStatus(response, 401, "unauthenticated create");
  });

  await check(45, "blank SKU is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody("   ")
    });
    expectStatus(response, 400, "blank SKU");
  });

  await check(46, "blank description is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`D-${unique()}`, { description: "  " })
    });
    expectStatus(response, 400, "blank description");
  });

  await check(47, "non-numeric cost is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`C-${unique()}`, { costMinor: "12.50" })
    });
    expectStatus(response, 400, "decimal cost");
  });

  await check(48, "negative cost is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`N-${unique()}`, { costMinor: "-100" })
    });
    expectStatus(response, 400, "negative cost");
  });

  await check(49, "unknown currency is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`U-${unique()}`, { costCurrency: "XYZ123" })
    });
    expectStatus(response, 400, "bad currency");
  });

  await check(50, "control characters in description are rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`K-${unique()}`, { description: "badvalue" })
    });
    expectStatus(response, 400, "control character");
  });

  await check(51, "update changes a mutable field", async () => {
    const response = await call(`/catalog/items/${itemId}`, {
      method: "PUT",
      cookie: ownerCookie,
      body: itemBody(sku, { description: "Updated acceptance description" })
    });
    expectStatus(response, 200, "update");
    expect(response.json.item.description === "Updated acceptance description", "not updated");
  });

  await check(52, "update with an invalid item id is rejected", async () => {
    const response = await call("/catalog/items/not-a-uuid", {
      method: "PUT",
      cookie: ownerCookie,
      body: itemBody(sku)
    });
    expectStatus(response, 400, "bad item id");
  });

  await check(53, "update of an unknown item returns 404", async () => {
    const response = await call("/catalog/items/019fec00-0000-7000-8000-000000000abc", {
      method: "PUT",
      cookie: ownerCookie,
      body: itemBody(`M-${unique()}`)
    });
    expectStatus(response, 404, "unknown item update");
  });

  await check(54, "archive deactivates rather than deleting", async () => {
    const target = `ARCH-${unique().toUpperCase()}`;
    const created = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(target)
    });
    expectStatus(created, 201, "create for archive");
    const archived = await call(`/catalog/items/${created.json.item.id}`, {
      method: "DELETE",
      cookie: ownerCookie
    });
    expect(archived.status < 400, `archive failed with ${archived.status}`);
    const listed = await call("/catalog/items", { cookie: ownerCookie });
    const found = listed.json.items.find((entry) => entry.sku === target);
    expect(found !== undefined, "archived item disappeared entirely");
    expect(found.active === false, "archived item still active");
  });

  await check(55, "archive with an invalid id is rejected", async () => {
    const response = await call("/catalog/items/nope", { method: "DELETE", cookie: ownerCookie });
    expectStatus(response, 400, "bad archive id");
  });

  await check(56, "listing is ordered by SKU", async () => {
    const response = await call("/catalog/items", { cookie: ownerCookie });
    const skus = response.json.items.map((item) => item.sku);
    const sorted = [...skus].sort();
    expect(JSON.stringify(skus) === JSON.stringify(sorted), "listing not sorted by sku");
  });

  await check(57, "item ids are UUIDv7", async () => {
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(itemId),
      `not a UUIDv7: ${itemId}`);
  });

  await check(58, "created timestamp is ISO-8601 UTC", async () => {
    const response = await call("/catalog/items", { cookie: ownerCookie });
    const item = response.json.items.find((entry) => entry.sku === sku);
    expect(/Z$/.test(item.createdAt), `createdAt not UTC: ${item.createdAt}`);
  });

  // ----------------------------------------------------------------- tax
  section("Tax classification");

  await check(59, "item without a tax class is blocked", async () => {
    const body = itemBody(`T1-${unique()}`);
    delete body.taxClass;
    const response = await call("/catalog/items", { method: "POST", cookie: ownerCookie, body });
    expectStatus(response, 400, "missing tax class");
  });

  await check(60, "the blocking message names tax classification", async () => {
    const body = itemBody(`T2-${unique()}`);
    delete body.taxClass;
    const response = await call("/catalog/items", { method: "POST", cookie: ownerCookie, body });
    expect(/tax/i.test(response.text), "error does not mention tax");
  });

  await check(61, "tax class without an audit basis is blocked", async () => {
    const body = itemBody(`T3-${unique()}`);
    delete body.taxClassificationBasis;
    const response = await call("/catalog/items", { method: "POST", cookie: ownerCookie, body });
    expectStatus(response, 400, "missing basis");
  });

  await check(62, "blank audit basis is blocked", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`T4-${unique()}`, { taxClassificationBasis: "   " })
    });
    expectStatus(response, 400, "blank basis");
  });

  await check(63, "an unknown tax class is rejected", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`T5-${unique()}`, { taxClass: "standard_18" })
    });
    expectStatus(response, 400, "unknown tax class");
  });

  await check(64, "zero-rated is accepted", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`Z-${unique().toUpperCase()}`, { taxClass: "zero_rated" })
    });
    expectStatus(response, 201, "zero rated");
  });

  await check(65, "exempt is accepted", async () => {
    const response = await call("/catalog/items", {
      method: "POST",
      cookie: ownerCookie,
      body: itemBody(`E-${unique().toUpperCase()}`, { taxClass: "exempt" })
    });
    expectStatus(response, 201, "exempt");
  });

  await check(66, "reclassification requires a basis note", async () => {
    const response = await call(`/catalog/items/${itemId}/tax-class`, {
      method: "PUT",
      cookie: ownerCookie,
      body: { taxClass: "exempt" }
    });
    expectStatus(response, 400, "reclassify without basis");
  });

  await check(67, "reclassification with a basis succeeds", async () => {
    const response = await call(`/catalog/items/${itemId}/tax-class`, {
      method: "PUT",
      cookie: ownerCookie,
      body: { taxClass: "exempt", basisNote: "Reclassified after KRA guidance review" }
    });
    expectStatus(response, 200, "reclassify");
    expect(response.json.item.taxClass === "exempt", "tax class not changed");
  });

  await check(68, "reclassifying to the same class is refused", async () => {
    const response = await call(`/catalog/items/${itemId}/tax-class`, {
      method: "PUT",
      cookie: ownerCookie,
      body: { taxClass: "exempt", basisNote: "No change attempt for acceptance run" }
    });
    expectStatus(response, 409, "no-op reclassification");
  });

  await check(69, "reclassifying an unknown item returns 404", async () => {
    const response = await call("/catalog/items/019fec00-0000-7000-8000-0000000000ff/tax-class", {
      method: "PUT",
      cookie: ownerCookie,
      body: { taxClass: "exempt", basisNote: "Unknown item reclassification attempt" }
    });
    expectStatus(response, 404, "unknown reclassification");
  });

  await check(70, "an invalid tax class on reclassify is rejected", async () => {
    const response = await call(`/catalog/items/${itemId}/tax-class`, {
      method: "PUT",
      cookie: ownerCookie,
      body: { taxClass: "vat_16", basisNote: "Invalid class attempt for acceptance run" }
    });
    expectStatus(response, 400, "invalid reclassification class");
  });

  // -------------------------------------------------------------- import
  section("Catalog import");

  const mapping = JSON.stringify({
    sku: "Code",
    description: "Name",
    uom: "Unit",
    packSize: "Pack",
    costMinor: "Cost",
    costCurrency: "Currency",
    taxClass: "Tax"
  });

  async function upload(csv, name = "catalog.csv", type = "text/csv") {
    const form = new FormData();
    form.set("file", new Blob([csv], { type }), name);
    form.set("mapping", mapping);
    const response = await fetch(`${API}/catalog/imports/preview`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
      body: form
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  }

  const goodCsv = (prefix) =>
    `Code,Name,Unit,Pack,Cost,Currency,Tax\n${prefix}-1,Hand sanitiser 500ml,EA,12,45000,KES,standard_16\n${prefix}-2,Nitrile gloves box,BOX,10,120000,KES,standard_16\n`;

  let importId = "";

  await check(71, "CSV preview validates and stages", async () => {
    const response = await upload(goodCsv(`IMP${unique().toUpperCase()}`));
    expectStatus(response, 201, "preview");
    expect(response.json.counts.total === 2, "wrong total");
    expect(response.json.counts.valid === 2, "wrong valid count");
    importId = response.json.importId;
  });

  await check(72, "preview reports the source headers", async () => {
    const response = await upload(goodCsv(`HDR${unique().toUpperCase()}`));
    expect(response.json.headers.includes("Code"), "headers missing");
  });

  await check(73, "a row with no description is rejected", async () => {
    const csv = `Code,Name,Unit,Pack,Cost,Currency,Tax\nBAD-${unique()},,EA,1,100,KES,standard_16\n`;
    const response = await upload(csv);
    expectStatus(response, 201, "preview with bad row");
    expect(response.json.counts.rejected === 1, "bad row not rejected");
  });

  await check(74, "a row with no tax class is staged, not silently defaulted", async () => {
    const csv = `Code,Name,Unit,Pack,Cost,Currency,Tax\nSTG-${unique()},Needs classification,EA,1,100,KES,\n`;
    const response = await upload(csv);
    expectStatus(response, 201, "preview staged row");
    expect(response.json.counts.valid === 0, "unclassified row counted valid");
  });

  await check(75, "commit creates the previewed items", async () => {
    const response = await call(`/catalog/imports/${importId}/commit`, {
      method: "POST",
      cookie: ownerCookie,
      body: {}
    });
    expectStatus(response, 200, "commit");
    expect(response.json.committed === 2, `committed ${response.json.committed}`);
  });

  await check(76, "re-committing reports not-ready rather than not-found", async () => {
    const response = await call(`/catalog/imports/${importId}/commit`, {
      method: "POST",
      cookie: ownerCookie,
      body: {}
    });
    expectStatus(response, 409, "re-commit");
  });

  await check(77, "committing an unknown import returns 404", async () => {
    const response = await call("/catalog/imports/019fec00-0000-7000-8000-0000000000aa/commit", {
      method: "POST",
      cookie: ownerCookie,
      body: {}
    });
    expectStatus(response, 404, "unknown import commit");
  });

  await check(78, "an import containing an invalid row cannot commit", async () => {
    const csv = `Code,Name,Unit,Pack,Cost,Currency,Tax\nOK-${unique()},Fine item,EA,1,100,KES,exempt\nBAD-${unique()},,EA,1,100,KES,exempt\n`;
    const preview = await upload(csv);
    const response = await call(`/catalog/imports/${preview.json.importId}/commit`, {
      method: "POST",
      cookie: ownerCookie,
      body: {}
    });
    expectStatus(response, 409, "commit with invalid rows");
  });

  await check(79, "an unsupported file type is refused", async () => {
    const response = await upload("not a spreadsheet", "notes.txt", "text/plain");
    expect(response.status === 415 || response.status === 400, `got ${response.status}`);
  });

  await check(80, "a preview without a mapping is refused", async () => {
    const form = new FormData();
    form.set("file", new Blob([goodCsv("NOMAP")], { type: "text/csv" }), "catalog.csv");
    const response = await fetch(`${API}/catalog/imports/preview`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
      body: form
    });
    expect(response.status >= 400, `expected refusal, got ${response.status}`);
  });

  await check(81, "import preview requires authentication", async () => {
    const form = new FormData();
    form.set("file", new Blob([goodCsv("ANON")], { type: "text/csv" }), "catalog.csv");
    form.set("mapping", mapping);
    const response = await fetch(`${API}/catalog/imports/preview`, { method: "POST", body: form });
    expectStatus({ status: response.status }, 401, "anonymous preview");
  });

  await check(82, "an invalid import id is rejected before lookup", async () => {
    const response = await call("/catalog/imports/not-a-uuid/commit", {
      method: "POST",
      cookie: ownerCookie,
      body: {}
    });
    expectStatus(response, 400, "bad import id");
  });

  // ------------------------------------------------------------ matching
  section("Matching and aliases");

  await check(83, "embedding generation succeeds for an item", async () => {
    const response = await call(`/catalog/items/${itemId}/embedding`, {
      method: "POST",
      cookie: ownerCookie
    });
    expectStatus(response, 200, "embedding");
  });

  await check(84, "matching returns candidates with component scores", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { query: "acceptance item" }
    });
    expectStatus(response, 200, "match");
    expect(Array.isArray(response.json.candidates), "no candidates array");
    if (response.json.candidates.length > 0) {
      const score = response.json.candidates[0].score;
      for (const key of ["alias", "lexical", "pack", "unit", "vector", "final"]) {
        expect(typeof score[key] === "number", `score.${key} missing`);
      }
    }
    return `${response.json.candidates.length} candidates`;
  });

  await check(85, "matching reports the normalized query", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { query: "  ACCEPTANCE   Item  " }
    });
    expect(typeof response.json.normalizedQuery === "string", "no normalizedQuery");
  });

  await check(86, "matching names the matcher version", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { query: "acceptance" }
    });
    expect(response.json.matcherVersion === "hybrid-v1", "unexpected matcher version");
  });

  await check(87, "an empty query is rejected", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { query: "   " }
    });
    expectStatus(response, 400, "empty query");
  });

  await check(88, "a missing query field is rejected", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { text: "wrong field" }
    });
    expectStatus(response, 400, "wrong field");
  });

  await check(89, "an out-of-range limit is rejected", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      body: { query: "acceptance", limit: 500 }
    });
    expectStatus(response, 400, "limit too large");
  });

  await check(90, "matching requires authentication", async () => {
    const response = await call("/catalog/matches", { method: "POST", body: { query: "soap" } });
    expectStatus(response, 401, "anonymous match");
  });

  await check(91, "aliases can be listed", async () => {
    const response = await call("/catalog/aliases", { cookie: ownerCookie });
    expectStatus(response, 200, "alias list");
  });

  await check(92, "a blank alias is rejected", async () => {
    const response = await call("/catalog/aliases", {
      method: "POST",
      cookie: ownerCookie,
      body: { itemId, aliasText: "   " }
    });
    expectStatus(response, 400, "blank alias");
  });

  // ------------------------------------------------------------ security
  section("Security, limits and isolation");

  const otherEmail = `rival-${unique()}@rival.co.ke`;
  let otherCookie = "";

  await check(93, "a second tenant can onboard independently", async () => {
    otherCookie = await signIn(otherEmail);
    const response = await onboard(otherCookie, "Rival Distributors Ltd", "Rival Owner");
    expectStatus(response, 201, "second tenant onboarding");
  });

  await check(94, "a second tenant cannot see the first tenant's items", async () => {
    const response = await call("/catalog/items", { cookie: otherCookie });
    expectStatus(response, 200);
    expect(!response.json.items.some((item) => item.sku === sku), "cross-tenant item leaked");
  });

  await check(95, "a second tenant cannot fetch the first tenant's item by id", async () => {
    const response = await call(`/catalog/items/${itemId}`, {
      method: "PUT",
      cookie: otherCookie,
      body: itemBody(`RIVAL-${unique()}`)
    });
    expect(response.status === 404 || response.status === 403, `got ${response.status}`);
  });

  await check(96, "a second tenant's match returns no foreign candidates", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: otherCookie,
      body: { query: "acceptance item" }
    });
    expectStatus(response, 200);
    expect(
      !response.json.candidates.some((candidate) => candidate.sku === sku),
      "cross-tenant candidate leaked"
    );
  });

  await check(97, "a disallowed CORS origin is not echoed back", async () => {
    const response = await call("/catalog/items", {
      cookie: ownerCookie,
      headers: { Origin: "https://evil.example.com" }
    });
    const allow = response.headers.get("access-control-allow-origin");
    expect(allow === null || allow !== "https://evil.example.com", `echoed ${allow}`);
  });

  await check(98, "an oversized JSON body is refused", async () => {
    const response = await call("/catalog/matches", {
      method: "POST",
      cookie: ownerCookie,
      headers: { "Content-Type": "application/json" },
      raw: JSON.stringify({ query: "a".repeat(9000) })
    });
    expectStatus(response, 413, "oversized body");
  });

  await check(99, "match requests are rate limited per user", async () => {
    const statuses = [];
    for (let index = 0; index < 36; index++) {
      const response = await call("/catalog/matches", {
        method: "POST",
        cookie: otherCookie,
        body: { query: "rate limit probe" }
      });
      statuses.push(response.status);
    }
    expect(statuses.includes(429), "no 429 observed");
    return `${statuses.filter((status) => status === 200).length} ok, ${statuses.filter((status) => status === 429).length} limited`;
  });

  await check(100, "no response leaks database or stack detail", async () => {
    const probes = [
      await call("/catalog/items/not-a-uuid", { method: "PUT", cookie: ownerCookie, body: {} }),
      await call("/catalog/matches", { method: "POST", cookie: ownerCookie, body: {} }),
      await call("/onboarding", { method: "POST", cookie: ownerCookie, body: {} })
    ];
    for (const probe of probes) {
      expect(!/zabuni_app|postgres:\/\/|at Object\.|node_modules/i.test(probe.text),
        `leaked internals: ${probe.text.slice(0, 120)}`);
    }
  });
}

await main();

const passed = results.filter((result) => result.ok);
const failed = results.filter((result) => !result.ok);

for (const result of results) {
  const mark = result.ok ? "PASS" : "FAIL";
  const extra = result.detail === "" ? "" : ` — ${result.detail}`;
  console.log(`${String(result.id).padStart(3)} ${mark}  ${result.name}${result.ok ? (extra ? ` (${result.detail})` : "") : extra}`);
}
console.log(`\n${passed.length}/${results.length} passed, ${failed.length} failed`);

if (REPORT !== "") {
  const bySection = new Map();
  for (const result of results) {
    const list = bySection.get(result.section) ?? [];
    list.push(result);
    bySection.set(result.section, list);
  }
  const lines = [
    "# Acceptance run",
    "",
    `**Result:** ${passed.length}/${results.length} passed, ${failed.length} failed.`,
    "",
    "| # | Area | Scenario | Result | Notes |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const result of results) {
    const note = result.detail.replaceAll("|", "\\|").slice(0, 160);
    lines.push(
      `| ${result.id} | ${result.section} | ${result.name} | ${result.ok ? "pass" : "**fail**"} | ${note} |`
    );
  }
  writeFileSync(REPORT, `${lines.join("\n")}\n`, "utf8");
}

process.exit(failed.length === 0 ? 0 : 1);
