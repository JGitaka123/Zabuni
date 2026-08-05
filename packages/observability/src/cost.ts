export interface LlmTokenUsage {
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
}

export interface LlmPrice {
  readonly model: string;
  readonly version: string;
  readonly currency: string;
  readonly inputMinorPerMillionTokens: bigint;
  readonly outputMinorPerMillionTokens: bigint;
}

export interface LlmCost {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly priceVersion: string;
}

const TOKENS_PER_MILLION = 1_000_000n;

function nonnegative(value: bigint, name: string): void {
  if (value < 0n) throw new RangeError(`${name} must not be negative`);
}

function isoCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error("currency must be an ISO-4217 code");
  return normalized;
}

/** Calculates the total call cost using bigint arithmetic and half-up rounding. */
export function calculateLlmCost(usage: LlmTokenUsage, price: LlmPrice): LlmCost {
  nonnegative(usage.inputTokens, "inputTokens");
  nonnegative(usage.outputTokens, "outputTokens");
  nonnegative(price.inputMinorPerMillionTokens, "input price");
  nonnegative(price.outputMinorPerMillionTokens, "output price");
  if (price.model.trim().length === 0) throw new Error("model must not be blank");
  const priceVersion = price.version.trim();
  if (priceVersion.length === 0) throw new Error("price version must not be blank");

  const numerator =
    usage.inputTokens * price.inputMinorPerMillionTokens +
    usage.outputTokens * price.outputMinorPerMillionTokens;
  return {
    amountMinor: (numerator + TOKENS_PER_MILLION / 2n) / TOKENS_PER_MILLION,
    currency: isoCurrency(price.currency),
    priceVersion
  };
}
