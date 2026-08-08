import { createHash } from "node:crypto";

import type { CatalogMatchResult } from "./matching.js";

export interface MatchEvaluationCase {
  readonly query: string;
  readonly expectedSku: string;
}

export interface MatchEvaluationFailure extends MatchEvaluationCase {
  readonly actualSku: string | null;
}

export interface MatchEvaluationReport {
  readonly correct: number;
  readonly total: number;
  readonly top1Accuracy: number;
  readonly passesEightyPercent: boolean;
  readonly datasetChecksum: string;
  readonly catalogChecksum: string;
  readonly matcherVersion: string;
  readonly failures: readonly MatchEvaluationFailure[];
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export async function evaluateTopOne(input: {
  readonly cases: readonly MatchEvaluationCase[];
  readonly catalogIdentity: readonly { readonly sku: string; readonly contentHash: string }[];
  readonly match: (query: string) => Promise<CatalogMatchResult>;
}): Promise<MatchEvaluationReport> {
  if (input.cases.length === 0) throw new Error("Match evaluation dataset must not be empty");
  const failures: MatchEvaluationFailure[] = [];
  let correct = 0;
  let matcherVersion: string | undefined;
  for (const evaluationCase of input.cases) {
    const result = await input.match(evaluationCase.query);
    matcherVersion ??= result.matcherVersion;
    const actualSku = result.candidates[0]?.sku ?? null;
    if (actualSku === evaluationCase.expectedSku) correct += 1;
    else failures.push({ ...evaluationCase, actualSku });
  }
  const top1Accuracy = correct / input.cases.length;
  return {
    correct,
    total: input.cases.length,
    top1Accuracy,
    passesEightyPercent: top1Accuracy >= 0.8,
    datasetChecksum: checksum(input.cases),
    catalogChecksum: checksum(
      [...input.catalogIdentity].sort((left, right) => left.sku.localeCompare(right.sku, "en-KE"))
    ),
    matcherVersion: matcherVersion ?? "unknown",
    failures
  };
}
