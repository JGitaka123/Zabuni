import { describe, expect, it } from "vitest";

import {
  Money,
  MoneyParseError,
  currencyCode,
  currencyMinorUnitExponent,
  formatMinorUnits,
  formatMoneyAmount,
  parseMoneyAmount
} from "../src/money.js";

describe("Money", () => {
  it("constructs and serializes immutable bigint minor units", () => {
    const money = new Money(123_456_789_012_345_678_901n, "KES");

    expect(money.minorUnits).toBe(123_456_789_012_345_678_901n);
    expect(money.currency).toBe("KES");
    expect(Object.isFrozen(money)).toBe(true);
    expect(money.toJSON()).toEqual({
      minorUnits: "123456789012345678901",
      currency: "KES",
    });
    expect(Object.isFrozen(money.toJSON())).toBe(true);
    expect(JSON.stringify(money)).toBe(
      '{"minorUnits":"123456789012345678901","currency":"KES"}',
    );
  });

  it("deserializes integer strings including negative and zero amounts", () => {
    expect(Money.fromJSON({ minorUnits: "-0", currency: currencyCode("USD") })).toEqual(
      new Money(0n, "USD"),
    );
    expect(Money.fromJSON({ minorUnits: "1", currency: currencyCode("KES") })).toEqual(
      new Money(1n, "KES"),
    );
  });

  it("rejects invalid serialization, currency codes, and non-bigint runtime input", () => {
    expect(() => Money.fromJSON({ minorUnits: "1.2", currency: currencyCode("KES") })).toThrow(
      "base-10 integer string",
    );
    expect(() => currencyCode("kes")).toThrow("Unsupported ISO-4217");
    expect(() => currencyCode("ZZZ")).toThrow("Unsupported ISO-4217");
    expect(() => new Money(1 as never, "KES")).toThrow("minorUnits must be a bigint");
    expect(() => Money.fromJSON(null)).toThrow("must be an object");
    expect(() => Money.fromJSON({ minorUnits: 1n, currency: "KES" })).toThrow(
      "integer string"
    );
    expect(() => Money.fromJSON({ minorUnits: "1", currency: 404 })).toThrow(
      "currency must be"
    );
  });

  it("adds, subtracts, and negates without mutating operands", () => {
    const left = new Money(9_000_000_000_000_000_000n, "KES");
    const right = new Money(2n, "KES");

    expect(left.add(right)).toEqual(new Money(9_000_000_000_000_000_002n, "KES"));
    expect(left.subtract(right)).toEqual(new Money(8_999_999_999_999_999_998n, "KES"));
    expect(right.negate()).toEqual(new Money(-2n, "KES"));
    expect(left.minorUnits).toBe(9_000_000_000_000_000_000n);
  });

  it("rejects currency mismatches for addition and subtraction", () => {
    const kes = new Money(1n, "KES");
    const usd = new Money(1n, "USD");

    expect(() => kes.add(usd)).toThrow("Currency mismatch: KES and USD");
    expect(() => kes.subtract(usd)).toThrow("Currency mismatch: KES and USD");
  });

  it("applies integer basis points with half-away-from-zero rounding", () => {
    expect(new Money(101n, "KES").applyBasisPoints(5_000n).minorUnits).toBe(51n);
    expect(new Money(-101n, "KES").applyBasisPoints(5_000n).minorUnits).toBe(-51n);
    expect(new Money(101n, "KES").applyBasisPoints(-5_000n).minorUnits).toBe(-51n);
    expect(new Money(-101n, "KES").applyBasisPoints(-5_000n).minorUnits).toBe(51n);
    expect(new Money(101n, "KES").applyBasisPoints(4_999n).minorUnits).toBe(50n);
    expect(new Money(1n, "KES").applyBasisPoints(0n).minorUnits).toBe(0n);
    expect(() => new Money(1n, "KES").applyBasisPoints(2 as never)).toThrow(
      "basisPoints must be a bigint",
    );
  });

  it("allocates weighted amounts with stable index-order remainder distribution", () => {
    const parts = new Money(10n, "KES").allocate([1n, 1n, 1n, 0n]);

    expect(parts.map((part) => part.minorUnits)).toEqual([4n, 3n, 3n, 0n]);
    expect(parts.every((part) => part.currency === "KES")).toBe(true);
    expect(Object.isFrozen(parts)).toBe(true);
  });

  it("allocates negative amounts symmetrically and handles tiny or zero amounts", () => {
    expect(
      new Money(-2n, "KES").allocate([1n, 1n, 1n]).map((part) => part.minorUnits),
    ).toEqual([-1n, -1n, 0n]);
    expect(
      new Money(0n, "KES").allocate([2n, 1n]).map((part) => part.minorUnits),
    ).toEqual([0n, 0n]);
  });

  it("rejects invalid allocation weights", () => {
    const money = new Money(10n, "KES");

    expect(() => money.allocate([])).toThrow("At least one");
    expect(() => money.allocate([1n, -1n])).toThrow("cannot be negative");
    expect(() => money.allocate([0n, 0n])).toThrow("greater than zero");
    expect(() => money.allocate([1 as never])).toThrow("Allocation weight must be a bigint");
  });

  it("compares both amount and currency", () => {
    const money = new Money(12n, "KES");

    expect(money.equals(new Money(12n, "KES"))).toBe(true);
    expect(money.equals(new Money(13n, "KES"))).toBe(false);
    expect(money.equals(new Money(12n, "USD"))).toBe(false);
  });
});

describe("currencyMinorUnitExponent", () => {
  it("knows the currencies whose exponent is not two", () => {
    expect(currencyMinorUnitExponent("KES")).toBe(2);
    expect(currencyMinorUnitExponent("USD")).toBe(2);
    expect(currencyMinorUnitExponent("TZS")).toBe(2);
    // East Africa is the stated footprint and these two differ, so a shared
    // "assume cents" rule would scale every Ugandan price by a hundred.
    expect(currencyMinorUnitExponent("UGX")).toBe(0);
    expect(currencyMinorUnitExponent("RWF")).toBe(0);
    expect(currencyMinorUnitExponent("JPY")).toBe(0);
    expect(currencyMinorUnitExponent("KWD")).toBe(3);
    expect(currencyMinorUnitExponent("CLF")).toBe(4);
  });

  it("refuses codes that have no minor unit", () => {
    expect(() => currencyMinorUnitExponent("XAU")).toThrow("no ISO-4217 minor unit");
    expect(() => currencyMinorUnitExponent("XXX")).toThrow("no ISO-4217 minor unit");
  });

  it("refuses codes that are not ISO-4217 at all", () => {
    expect(() => currencyMinorUnitExponent("KSH")).toThrow("Unsupported ISO-4217");
  });
});

describe("parseMoneyAmount", () => {
  const parsed = (raw: string, currency = "KES"): bigint =>
    parseMoneyAmount(raw, currency).minorUnits;

  it("reads the shapes a real price list actually contains", () => {
    expect(parsed("1234.56")).toBe(123_456n);
    expect(parsed("1,234.56")).toBe(123_456n);
    expect(parsed("1234")).toBe(123_400n);
    expect(parsed("1,234")).toBe(123_400n);
    expect(parsed("1234.5")).toBe(123_450n);
    expect(parsed("0.07")).toBe(7n);
    expect(parsed("0")).toBe(0n);
    expect(parsed("12,345,678.90")).toBe(1_234_567_890n);
    expect(parsed("1'234.56")).toBe(123_456n);
    expect(parsed("1 234.56")).toBe(123_456n);
    expect(parsed("1 234.56")).toBe(123_456n);
  });

  it("is exact where a float would not be", () => {
    // 70.07 * 100 is 7006.999999999999 as a double, and 8.165 rounds the wrong
    // way on a half. Read as digits, neither is in any danger.
    expect(parsed("70.07")).toBe(7_007n);
    expect(parsed("8.16")).toBe(816n);
    expect(parsed("0.29")).toBe(29n);
    // Past IEEE-754's exact integer range, where a double rounds silently.
    expect(parsed("99999999999999.99")).toBe(9_999_999_999_999_999n);
    // A half-cent is never quietly dropped: it is a data problem to surface.
    expect(() => parseMoneyAmount("1.005", "KES")).toThrow(/2 decimal places/u);
  });

  it("accepts the currency written next to the amount", () => {
    expect(parsed("KES 1,234.56")).toBe(123_456n);
    expect(parsed("KSh 1,234.56")).toBe(123_456n);
    expect(parsed("KShs. 1,234.56")).toBe(123_456n);
    expect(parsed("1,500/=")).toBe(150_000n);
    expect(parsed("1,500/-")).toBe(150_000n);
    expect(parsed("KSh 1,500/=")).toBe(150_000n);
    expect(parsed("$40.00", "USD")).toBe(4_000n);
    expect(parsed("US$ 40", "USD")).toBe(4_000n);
    expect(parsed("40.00 USD", "USD")).toBe(4_000n);
  });

  it("refuses an amount labelled with a different currency", () => {
    // The dangerous case: a USD price list imported into a KES column would
    // otherwise be recorded at roughly a hundredth of its value.
    for (const raw of ["USD 40.00", "$40.00", "€40.00", "40 USD"]) {
      expect(() => parseMoneyAmount(raw, "KES")).toThrow(/carries a currency other than KES/u);
    }
    expect(() => parseMoneyAmount("KSh 40", "USD")).toThrow(/other than USD/u);
  });

  it("refuses European notation instead of guessing which convention it is", () => {
    for (const raw of ["1.234,56", "1 234,56", "1234,56", "1,56"]) {
      expect(() => parseMoneyAmount(raw, "KES")).toThrow(MoneyParseError);
      try {
        parseMoneyAmount(raw, "KES");
      } catch (error) {
        expect((error as MoneyParseError).reason).toBe("ambiguous_separators");
      }
    }
  });

  it("refuses mixed thousands separators", () => {
    expect(() => parseMoneyAmount("1,234 567.00", "KES")).toThrow(
      /more than one kind of thousands separator/u
    );
  });

  it("refuses malformed groupings rather than reading past them", () => {
    for (const raw of ["1,23,456.00", "12,34.00", "1,2345.00", ",234.00"]) {
      expect(() => parseMoneyAmount(raw, "KES")).toThrow(MoneyParseError);
    }
  });

  it("refuses precision the currency cannot hold, but allows trailing zeros", () => {
    expect(parsed("1500.00", "UGX")).toBe(1_500n);
    expect(parsed("1234.5600", "KES")).toBe(123_456n);
    expect(() => parseMoneyAmount("1234.567", "KES")).toThrow(/KES has 2 decimal places/u);
    expect(() => parseMoneyAmount("1500.50", "UGX")).toThrow(/UGX has no decimal places/u);
    expect(parsed("1.234", "KWD")).toBe(1_234n);
  });

  it("refuses negatives, including the accounting parenthesis", () => {
    for (const raw of ["-1234.56", "(1,234.56)", "- 5"]) {
      expect(() => parseMoneyAmount(raw, "KES")).toThrow("cannot be negative");
    }
  });

  it("refuses blanks, junk, and half-written decimals", () => {
    expect(() => parseMoneyAmount("", "KES")).toThrow("blank");
    expect(() => parseMoneyAmount("   ", "KES")).toThrow("blank");
    expect(() => parseMoneyAmount("1234.", "KES")).toThrow("no digits after it");
    // A cell holding only the currency, which a price list uses as a heading.
    expect(() => parseMoneyAmount("KES", "KES")).toThrow("has no digits");
    expect(() => parseMoneyAmount("KSh", "KES")).toThrow("has no digits");
    expect(() => parseMoneyAmount("12.34.56", "KES")).toThrow("more than one decimal point");
    expect(() => parseMoneyAmount("n/a", "KES")).toThrow(MoneyParseError);
    expect(() => parseMoneyAmount("1234e5", "KES")).toThrow(MoneyParseError);
    // Non-ASCII digits are not silently transliterated.
    expect(() => parseMoneyAmount("١٢٣٤", "KES")).toThrow(MoneyParseError);
  });

  it("refuses amounts too large to survive later arithmetic", () => {
    expect(() => parseMoneyAmount("10000000000000000.00", "KES")).toThrow(
      "larger than this system records"
    );
  });

  it("refuses currencies with no minor unit", () => {
    expect(() => parseMoneyAmount("1.00", "XAU")).toThrow("has no minor unit");
  });

  it("reports a reason code for every refusal", () => {
    const reasons = new Set<string>();
    for (const [raw, currency] of [
      ["", "KES"],
      ["1.00", "XAU"],
      ["n/a", "KES"],
      ["-1", "KES"],
      ["1,56", "KES"],
      ["1234.567", "KES"],
      ["USD 4", "KES"],
      ["10000000000000000", "KES"]
    ] as const) {
      try {
        parseMoneyAmount(raw, currency);
        throw new Error(`expected ${raw} to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(MoneyParseError);
        reasons.add((error as MoneyParseError).reason);
      }
    }
    expect(reasons).toEqual(
      new Set([
        "empty",
        "no_minor_unit",
        "malformed",
        "negative",
        "ambiguous_separators",
        "too_many_decimal_places",
        "currency_mismatch",
        "too_large"
      ])
    );
  });
});

describe("formatMinorUnits", () => {
  it("renders the amount a person reads, not the stored minor units", () => {
    expect(formatMinorUnits(123_456n, "KES")).toBe("1,234.56");
    expect(formatMinorUnits(7n, "KES")).toBe("0.07");
    expect(formatMinorUnits(0n, "KES")).toBe("0.00");
    expect(formatMinorUnits(100n, "KES")).toBe("1.00");
    expect(formatMinorUnits(1_234_567_890n, "KES")).toBe("12,345,678.90");
    expect(formatMinorUnits(999n, "KES")).toBe("9.99");
  });

  it("uses the currency's own precision", () => {
    expect(formatMinorUnits(1_500n, "UGX")).toBe("1,500");
    expect(formatMinorUnits(1_234n, "KWD")).toBe("1.234");
    expect(formatMinorUnits(1_000_000n, "JPY")).toBe("1,000,000");
  });

  it("round-trips whatever the parser accepted", () => {
    for (const raw of ["1234.56", "0.07", "1,234.56", "999999.99"]) {
      const money = parseMoneyAmount(raw, "KES");
      expect(parseMoneyAmount(formatMoneyAmount(money), "KES").minorUnits).toBe(money.minorUnits);
    }
  });

  it("handles negatives and currencies with no minor unit without throwing", () => {
    expect(formatMinorUnits(-123_456n, "KES")).toBe("-1,234.56");
    expect(formatMinorUnits(-7n, "KES")).toBe("-0.07");
    expect(formatMinorUnits(5n, "XAU")).toBe("5");
  });

  it("is exact past the range a double can represent", () => {
    expect(formatMinorUnits(123_456_789_012_345_678_901n, "KES")).toBe(
      "1,234,567,890,123,456,789.01"
    );
  });
});
