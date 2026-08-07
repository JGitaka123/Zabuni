import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 1_024;
export const MAX_MATCH_TEXT_LENGTH = 1_000;

export interface EmbeddingDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
}

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embed(normalizedText: string): Promise<readonly number[]>;
}

export interface SearchableItemText {
  readonly sku: string;
  readonly description: string;
  readonly brand: string | null;
  readonly packSize: string | null;
  readonly uom: string | null;
}

const unitReplacements: readonly (readonly [RegExp, string])[] = [
  [/\b(?:litres?|liters?|ltrs?|lts?)\b/gu, "l"],
  [/\b(?:millilitres?|milliliters?|mls?)\b/gu, "ml"],
  [/\b(?:kilograms?|kgs?)\b/gu, "kg"],
  [/\b(?:grams?|gms?)\b/gu, "g"],
  [/\b(?:pieces?|pcs?)\b/gu, "pc"]
];

function containsUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function normalizeMatchText(value: string): string {
  if (
    value.trim() === "" ||
    value.length > MAX_MATCH_TEXT_LENGTH ||
    containsUnsafeCharacter(value)
  ) {
    throw new Error("Match text must contain 1 to 1000 safe characters");
  }
  let normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-KE");
  for (const [pattern, replacement] of unitReplacements) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/(\d)\s+(ml|kg|pc|l|g)\b/gu, "$1$2")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function buildItemSearchText(item: SearchableItemText): string {
  return normalizeMatchText(
    [item.sku, item.description, item.brand, item.packSize, item.uom]
      .filter((value): value is string => value !== null && value.trim() !== "")
      .join(" ")
  );
}

export function embeddingContentHash(normalizedText: string): string {
  return createHash("sha256").update(normalizedText, "utf8").digest("hex");
}

export function validateEmbedding(
  embedding: readonly number[],
  dimensions = EMBEDDING_DIMENSIONS
): number[] {
  if (embedding.length !== dimensions) {
    throw new Error(`Embedding must contain exactly ${String(dimensions)} dimensions`);
  }
  const result = embedding.map((value) => {
    if (!Number.isFinite(value)) throw new Error("Embedding values must be finite");
    return value;
  });
  if (result.every((value) => value === 0)) throw new Error("Embedding must not be a zero vector");
  return result;
}

function fnv1a(value: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

/**
 * Fully offline fixture transport. Feature hashing gives stable, non-zero
 * vectors for plumbing and ranking tests; it is not a production semantic
 * embedding model and must never be used to claim the Safuney accuracy gate.
 */
export class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor = {
    provider: "fixture",
    model: "token-feature-hash",
    version: "1",
    dimensions: EMBEDDING_DIMENSIONS
  };

  embed(normalizedText: string): Promise<readonly number[]> {
    const text = normalizeMatchText(normalizedText);
    const vector = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0);
    const tokens = text.split(" ");
    const features = [
      ...tokens,
      ...tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1] ?? ""}`)
    ];
    for (const feature of features) {
      const hash = fnv1a(feature);
      const position = hash % EMBEDDING_DIMENSIONS;
      vector[position] = (vector[position] ?? 0) + ((hash & 0x8000_0000) === 0 ? 1 : -1);
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return Promise.resolve(validateEmbedding(vector.map((value) => value / magnitude)));
  }
}
