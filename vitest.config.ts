import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts", "plugins/*/tests/**/*.test.ts"],
    environment: "node",
  },
});
