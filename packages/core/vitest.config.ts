import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["../../test/network-guard.ts"],
    coverage: {
      provider: "v8",
      include: ["src/money.ts"],
      reportsDirectory: join(tmpdir(), "zabuni-core-coverage"),
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
