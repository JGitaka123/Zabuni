import eslint from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/next-env.d.ts"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error"
    }
  },
  // Order matters. Flat config REPLACES a rule's options rather than merging
  // them, so the narrower request-path block must come last and restate every
  // path it needs. Listing api/web first silently dropped the outbox
  // restriction, leaving the cross-tenant boundary unguarded.
  {
    files: ["apps/**/*.ts", "apps/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@zabuni/db/admin",
              message: "Request and worker code must use tenant-scoped database APIs."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["apps/api/**/*.ts", "apps/api/**/*.tsx", "apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@zabuni/db/admin",
              message: "Request-path code must use tenant-scoped database APIs."
            },
            {
              name: "@zabuni/db/privileged/outbox",
              message: "Request-path code must never import the cross-tenant outbox boundary."
            }
          ]
        }
      ]
    }
  },
  // Registered without a `files` filter on purpose: `next build` detects the
  // plugin by resolving the config for eslint.config.mjs itself, so a block
  // scoped to apps/web leaves it undetected. Registering a plugin enables no
  // rules by itself; the rules stay scoped to the web app below.
  { plugins: { "@next/next": nextPlugin } },
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // App Router only: this rule hunts for a pages/ directory and emits a
      // "Pages directory cannot be found" notice on every run.
      "@next/next/no-html-link-for-pages": "off"
    }
  },
  {
    files: ["**/*.config.{js,mjs,ts}", "eslint.config.mjs"],
    ...tseslint.configs.disableTypeChecked
  }
);
