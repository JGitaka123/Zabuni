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

function assertBigInt(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint`);
  }
}

function roundedQuotientHalfAwayFromZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
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
      roundedQuotientHalfAwayFromZero(
        this.minorUnits * basisPoints,
        BASIS_POINT_DENOMINATOR,
      ),
      this.currency,
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
      0n,
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

    return Object.freeze(
      shares.map((share) => new Money(share * sign, this.currency)),
    );
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): SerializedMoney {
    return Object.freeze({
      minorUnits: this.minorUnits.toString(),
      currency: this.currency,
    });
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new RangeError(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
