import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/web/unit-tests/**/*.test.ts",
      "apps/worker/tests/**/*.test.ts",
      "deploy/**/*.test.mjs"
    ],
    exclude: ["**/node_modules/**", "**/.next/**"]
  }
});
