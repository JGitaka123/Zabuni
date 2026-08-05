import { describe, expect, it } from "vitest";

import { Money, currencyCode } from "../src/money.js";

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
