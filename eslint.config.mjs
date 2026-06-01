import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/", "reports/", "*.tsbuildinfo"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow unused args that start with _ (common TS/Node convention)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Project prefers factory functions over `new Class()`; Object.create
      // and similar patterns are intentional and shouldn't warn.
      "@typescript-eslint/no-extraneous-class": "off",

      // The ToolResult discriminated union pattern uses `if (!result.ok)` narrowing
      // which typescript-eslint sometimes over-flags.
      "@typescript-eslint/no-unnecessary-condition": "off",

      // The codebase deliberately uses `type X = { ... }` everywhere (not `interface`).
      // Keeping the convention uniform across aliases, unions, intersections, and primitives.
      "@typescript-eslint/consistent-type-definitions": "off",

      // Existing codebase uses both `T[]` and `Array<T>` interchangeably — cosmetic only.
      "@typescript-eslint/array-type": "off",

      // Empty functions are a legitimate pattern (no-op callbacks, placeholder factories).
      "@typescript-eslint/no-empty-function": "off",

      // ANSI escape sequences (\x1b, etc.) are intentional in terminal rendering code.
      "no-control-regex": "off",
    },
  },

  {
    // Tests are allowed looser rules (mocks, any, non-null assertions,
    // async-without-await for promise-returning mocks, Promise in void callback for afterEach cleanup, etc.)
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "require-yield": "off",
    },
  },

  {
    // Async generators used as keep-alive hangers (preflight.ts hangingPrompt) — legitimate pattern.
    files: ["src/auth/preflight.ts"],
    rules: {
      "require-yield": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  // Must come last — disables ESLint rules that conflict with Prettier
  prettier,
);
