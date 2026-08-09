import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface RestrictedPath {
  readonly name: string;
}

/**
 * Reads the effective `no-restricted-imports` paths for a file.
 *
 * ESLint flat config REPLACES a rule's options when a later block sets the same
 * rule, rather than merging them. Two blocks both matched apps/api and apps/web,
 * which silently dropped the cross-tenant outbox restriction. Asserting the
 * resolved options is the only way to catch that regression -- the config still
 * reads as though both restrictions apply.
 */
async function restrictedImportsFor(relativePath: string): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: repositoryRoot });
  const config: unknown = await eslint.calculateConfigForFile(
    resolve(repositoryRoot, relativePath)
  );

  if (typeof config !== "object" || config === null || !("rules" in config)) {
    throw new Error(`No resolved config for ${relativePath}`);
  }
  const rules = (config as { rules?: Record<string, unknown> }).rules ?? {};
  const entry = rules["no-restricted-imports"];
  if (!Array.isArray(entry)) return [];

  const options = entry[1] as { paths?: readonly RestrictedPath[] } | undefined;
  return (options?.paths ?? []).map(({ name }) => name);
}

describe("database import boundaries", () => {
  it("forbids request-path code from reaching the admin and outbox boundaries", async () => {
    for (const path of ["apps/api/src/app.ts", "apps/web/app/page.tsx"]) {
      const restricted = await restrictedImportsFor(path);
      expect(restricted).toContain("@zabuni/db/admin");
      expect(restricted).toContain("@zabuni/db/privileged/outbox");
    }
  });

  it("forbids worker code from reaching the admin boundary", async () => {
    const restricted = await restrictedImportsFor("apps/worker/src/loop.ts");
    expect(restricted).toContain("@zabuni/db/admin");
  });

  it("still allows the worker its privileged outbox boundary", async () => {
    // The worker is the one caller that legitimately drains across tenants.
    const restricted = await restrictedImportsFor("apps/worker/src/runtime.ts");
    expect(restricted).not.toContain("@zabuni/db/privileged/outbox");
  });
});
