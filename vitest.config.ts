import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "plugins/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    // The frontend runs separately with its own jsdom/setup config via the root test script.
    exclude: ["**/node_modules/**", "apps/novel-web/**"],
    environment: "node",
  },
});
