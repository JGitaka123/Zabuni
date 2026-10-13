// prettier-ignore
const ISO_4217_CODES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BOV",
  "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF",
  "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL",
  "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
  "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR",
  "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN",
  "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD",
  "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP",
  "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU",
  "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XAG", "XAU",
  "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF",
  "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG",
] as const);

/**
 * ISO-4217 minor-unit exponents that are not 2. Everything absent from these
 * two sets uses 2, which is the overwhelming majority.
 *
 * UGX and RWF are here and matter: East Africa is the stated footprint, and a
 * price of "1500" in Kampala is 1500 shillings, not fifteen. Treating UGX as
 * two-decimal would scale every Ugandan price by 100.
 */
// prettier-ignore
const ZERO_EXPONENT_CODES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
// prettier-ignore
const THREE_EXPONENT_CODES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);
// prettier-ignore
const FOUR_EXPONENT_CODES = new Set([
  "CLF", "UYW",
]);

/**
 * Codes with no minor unit at all: precious metals, IMF/bond units, and the
 * test and "no currency" placeholders. A decimal amount in one of these is
 * meaningless rather than merely unusual, so parsing refuses instead of
 * picking an exponent on the caller's behalf.
 */
// prettier-ignore
const NO_MINOR_UNIT_CODES = new Set([
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU",
  "XTS", "XUA", "XXX",
]);

declare const currencyCodeBrand: unique symbol;

/** A recognized ISO-4217 alphabetic code, including ISO special-purpose codes. */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };

export interface SerializedMoney {
  readonly minorUnits: string;
  readonly currency: CurrencyCode;
}

const BASIS_POINT_DENOMINATOR = 10_000n;

export function currencyCode(value: string): CurrencyCode {
  if (!ISO_4217_CODES.has(value as never)) {
    throw new RangeError(`Unsupported ISO-4217 currency code: ${value}`);
  }

  return value as CurrencyCode;
}

/**
 * How many decimal places the currency's minor unit has: KES 2, UGX 0, KWD 3.
 * Throws for codes that have no minor unit (XAU, XXX, and the other X-codes).
 */
export function currencyMinorUnitExponent(currency: string): number {
  const code = currencyCode(currency);
  if (NO_MINOR_UNIT_CODES.has(code)) {
    throw new RangeError(`${code} has no ISO-4217 minor unit`);
  }
  if (ZERO_EXPONENT_CODES.has(code)) return 0;
  if (THREE_EXPONENT_CODES.has(code)) return 3;
  if (FOUR_EXPONENT_CODES.has(code)) return 4;
  return 2;
}

export type MoneyParseFailure =
  | "ambiguous_separators"
  | "currency_mismatch"
  | "empty"
  | "malformed"
  | "negative"
  | "no_minor_unit"
  | "too_large"
  | "too_many_decimal_places";

/** A refusal to interpret a human-written amount, with the reason to show. */
export class MoneyParseError extends Error {
  readonly reason: MoneyParseFailure;

  constructor(reason: MoneyParseFailure, message: string) {
    super(message);
    this.name = "MoneyParseError";
    this.reason = reason;
  }
}

/**
 * Amounts at or above this are refused. The persisted column is a Postgres
 * bigint (max ~9.22e18), and later arithmetic multiplies by quantities and
 * basis points, so leaving several decades of headroom keeps that from
 * overflowing where it would be hardest to notice.
 */
const MAX_MINOR_UNITS = 10n ** 18n;

/**
 * Currency tokens accepted alongside an amount, per ISO code. A token is only
 * ever accepted when it names the currency the caller already expects, so
 * "USD 40.00" in a column mapped to KES is refused rather than imported at the
 * wrong currency. "/=" and "/-" are the Kenyan written suffix for whole
 * shillings, as in "1,500/=".
 */
const CURRENCY_TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  EUR: ["€"],
  GBP: ["£"],
  INR: ["₹", "RS.", "RS"],
  JPY: ["¥"],
  KES: ["KSHS.", "KSHS", "KSH.", "KSH", "SHS", "SH", "/=", "/-"],
  TZS: ["TSHS", "TSH.", "TSH"],
  UGX: ["USHS", "USH.", "USH"],
  USD: ["US$", "$"]
};

const GROUP_SEPARATOR_CLASS = "[,'\\u0020\\u00a0\\u202f\\u2009]";
const GROUP_SEPARATORS = new RegExp(GROUP_SEPARATOR_CLASS, "gu");
/** Separate from the global one, whose `lastIndex` makes `test` stateful. */
const HAS_GROUP_SEPARATOR = new RegExp(GROUP_SEPARATOR_CLASS, "u");
const GROUPED_INTEGER = new RegExp(`^\\d{1,3}(?:${GROUP_SEPARATOR_CLASS}\\d{3})+$`, "u");
const PLAIN_INTEGER = /^\d+$/u;
const CURRENCY_LIKE = /[\p{L}\p{Sc}]/u;

/** Longest token first, so "KSHS" is not consumed as "KSH" plus a stray "S". */
function currencyTokensFor(code: CurrencyCode): readonly string[] {
  return [code, ...(CURRENCY_TOKEN_ALIASES[code] ?? [])].toSorted(
    (left, right) => right.length - left.length
  );
}

/**
 * Removes the currency decoration around an amount, refusing any decoration
 * that names a different currency. Runs twice at most, so "KSh 1,500/=" loses
 * both ends.
 */
function withoutCurrencyTokens(value: string, code: CurrencyCode): string {
  const tokens = currencyTokensFor(code);
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const upper = current.toUpperCase();
    const token = tokens.find(
      (candidate) => upper.startsWith(candidate) || upper.endsWith(candidate)
    );
    if (token === undefined) break;
    current = (
      upper.startsWith(token)
        ? current.slice(token.length)
        : current.slice(0, current.length - token.length)
    ).trim();
  }
  if (CURRENCY_LIKE.test(current)) {
    // A cell with digits and some other currency's mark is a real price in the
    // wrong currency, and importing it would be a hundredfold error. A cell
    // with no digits at all is "n/a" or "POA" -- not an amount to begin with,
    // so say that rather than blaming the currency.
    if (!/\d/u.test(current)) {
      throw new MoneyParseError("malformed", `"${value}" is not an amount`);
    }
    throw new MoneyParseError(
      "currency_mismatch",
      `"${value}" carries a currency other than ${code}; map the currency column or remove the symbol`
    );
  }
  return current;
}

/**
 * Parses an amount written the way a person or a spreadsheet writes it --
 * "1234.56", "1,234.56", "KSh 1,234.56", "1,500/=" -- into exact minor units.
 *
 * This is string arithmetic, never floating point: the digits are concatenated
 * and read as a bigint, so no value is ever approximated. Decimal input is the
 * only reason this exists; `Money` still offers no way back out to a
 * major-unit or floating-point representation.
 *
 * Kenya's conventions decide the separators -- "." is the decimal point, ","
 * groups thousands. Anything that would need a guess is refused with a reason
 * instead of interpreted: "1.234,56" could be either convention, a comma
 * followed by two digits is a European decimal, and more decimal places than
 * the currency has cannot be exact. Trailing zeros past the currency's
 * precision are the one exception, because "1500.00" in UGX loses nothing.
 * Being a hundred times wrong about a price is worse than asking someone to
 * fix their spreadsheet.
 */
export function parseMoneyAmount(raw: string, currency: string): Money {
  const code = currencyCode(currency);
  if (NO_MINOR_UNIT_CODES.has(code)) {
    throw new MoneyParseError(
      "no_minor_unit",
      `${code} has no minor unit, so an amount in it cannot be recorded`
    );
  }
  const exponent = currencyMinorUnitExponent(code);
  const trimmed = raw.trim();
  if (trimmed === "") throw new MoneyParseError("empty", "The amount is blank");
  // Checked before the currency token is stripped, because "/-" is itself a
  // Kenyan currency suffix and must not read as a minus sign.
  if (trimmed.startsWith("-") || trimmed.startsWith("(") || trimmed.endsWith(")")) {
    throw new MoneyParseError("negative", "A catalog cost cannot be negative");
  }

  const body = withoutCurrencyTokens(trimmed, code);
  if (body === "") throw new MoneyParseError("malformed", `"${raw}" has no digits`);

  const firstDot = body.indexOf(".");
  const lastDot = body.lastIndexOf(".");
  if (firstDot !== lastDot) {
    throw new MoneyParseError("malformed", `"${raw}" has more than one decimal point`);
  }
  const integerPart = lastDot === -1 ? body : body.slice(0, lastDot);
  const fractionPart = lastDot === -1 ? "" : body.slice(lastDot + 1);

  // The decimal point must be the last separator. A group separator after it
  // means European notation, whose value depends on which convention you
  // assume, so it is named rather than resolved.
  if (HAS_GROUP_SEPARATOR.test(fractionPart)) {
    throw new MoneyParseError(
      "ambiguous_separators",
      `"${raw}" mixes decimal and thousands separators; write it as 1234.56 or 1,234.56`
    );
  }
  const separators = new Set(integerPart.match(GROUP_SEPARATORS) ?? []);
  if (separators.size > 1) {
    throw new MoneyParseError(
      "ambiguous_separators",
      `"${raw}" uses more than one kind of thousands separator`
    );
  }
  if (!PLAIN_INTEGER.test(integerPart) && !GROUPED_INTEGER.test(integerPart)) {
    throw new MoneyParseError(
      separators.size > 0 ? "ambiguous_separators" : "malformed",
      `"${raw}" is not a valid amount; write it as 1234.56 or 1,234.56`
    );
  }
  if (lastDot !== -1 && !PLAIN_INTEGER.test(fractionPart)) {
    throw new MoneyParseError("malformed", `"${raw}" has a decimal point with no digits after it`);
  }
  const significant = fractionPart.slice(0, exponent);
  if (fractionPart.slice(exponent).replaceAll("0", "") !== "") {
    throw new MoneyParseError(
      "too_many_decimal_places",
      exponent === 0
        ? `${code} has no decimal places, so "${raw}" cannot be recorded exactly`
        : `${code} has ${String(exponent)} decimal places, so "${raw}" cannot be recorded exactly`
    );
  }

  const digits = integerPart.replaceAll(GROUP_SEPARATORS, "") + significant.padEnd(exponent, "0");
  const minorUnits = BigInt(digits);
  if (minorUnits >= MAX_MINOR_UNITS) {
    throw new MoneyParseError("too_large", `"${raw}" is larger than this system records`);
  }
  return new Money(minorUnits, code);
}

/**
 * Renders minor units as the amount a person reads: 123456 KES as "1,234.56".
 *
 * String arithmetic again, so this is not the floating-point conversion the
 * `Money` class refuses to provide -- no Number is produced anywhere, and the
 * output is exact for every bigint. Prices have to be shown to people, and
 * showing them the raw minor units reads as a hundredfold error.
 */
export function formatMinorUnits(minorUnits: bigint, currency: string): string {
  const code = currencyCode(currency);
  // Display must never throw: an amount in a currency with no minor unit is
  // simply shown whole rather than refused at render time.
  const exponent = NO_MINOR_UNIT_CODES.has(code) ? 0 : currencyMinorUnitExponent(code);
  const negative = minorUnits < 0n;
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : digits.slice(digits.length - exponent);
  const grouped = whole.replace(/\B(?=(?:\d{3})+$)/gu, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Convenience over {@link formatMinorUnits} for an assembled amount. */
export function formatMoneyAmount(money: Money): string {
  return formatMinorUnits(money.minorUnits, money.currency);
}

function assertBigInt(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint`);
  }
}

function roundedQuotientHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;

  if (absoluteRemainder * 2n < denominator) {
    return quotient;
  }

  return quotient + (numerator < 0n ? -1n : 1n);
}

/**
 * An immutable monetary amount represented exclusively in bigint minor units.
 * The class intentionally has no major-unit or floating-point conversion API.
 */
export class Money {
  readonly minorUnits: bigint;
  readonly currency: CurrencyCode;

  constructor(minorUnits: bigint, currency: string) {
    assertBigInt(minorUnits, "minorUnits");
    this.minorUnits = minorUnits;
    this.currency = currencyCode(currency);
    Object.freeze(this);
  }

  static fromJSON(value: unknown): Money {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("Serialized money must be an object");
    }
    const record = value as Record<string, unknown>;
    const minorUnits = record.minorUnits;
    const serializedCurrency = record.currency;
    if (typeof minorUnits !== "string" || !/^-?\d+$/.test(minorUnits)) {
      throw new TypeError("Serialized minorUnits must be a base-10 integer string");
    }
    if (typeof serializedCurrency !== "string") {
      throw new TypeError("Serialized currency must be an ISO-4217 string");
    }

    return new Money(BigInt(minorUnits), serializedCurrency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  /** Applies integer basis points and rounds midpoint values away from zero. */
  applyBasisPoints(basisPoints: bigint): Money {
    assertBigInt(basisPoints, "basisPoints");
    return new Money(
      roundedQuotientHalfAwayFromZero(this.minorUnits * basisPoints, BASIS_POINT_DENOMINATOR),
      this.currency
    );
  }

  /**
   * Allocates the amount by non-negative bigint weights. Any remainder is
   * assigned one minor unit at a time in stable input-index order.
   */
  allocate(weights: readonly bigint[]): readonly Money[] {
    if (weights.length === 0) {
      throw new RangeError("At least one allocation weight is required");
    }

    for (const weight of weights) {
      assertBigInt(weight, "Allocation weight");
      if (weight < 0n) {
        throw new RangeError("Allocation weights cannot be negative");
      }
    }

    const totalWeight = weights.reduce((total, weight) => total + weight, 0n);
    if (totalWeight === 0n) {
      throw new RangeError("The total allocation weight must be greater than zero");
    }

    const sign = this.minorUnits < 0n ? -1n : 1n;
    const absoluteAmount = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const distributed = weights.reduce(
      (total, weight) => total + (absoluteAmount * weight) / totalWeight,
      0n
    );
    let remainder = absoluteAmount - distributed;
    const shares = weights.map((weight) => {
      let share = (absoluteAmount * weight) / totalWeight;
      if (weight !== 0n && remainder > 0n) {
        share += 1n;
        remainder -= 1n;
      }
      return share;
    });

    return Object.freeze(shares.map((share) => new Money(share * sign, this.currency)));
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): SerializedMoney {
    return Object.freeze({
      minorUnits: this.minorUnits.toString(),
      currency: this.currency
    });
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new RangeError(`Currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
