import { defineConfig } from "vitest/config";

/**
 * platform-store 自己的 vitest 配置。
 *
 * 根 vitest.config.ts 的 include 已覆盖 `packages/<pkg>/tests/<...>.test.ts`，
 * 所以 根配置会跑到这里；这个文件主要给 `pnpm --filter @myrix/platform-store test`
 * 提供独立的入口，并统一超时（PG 集成测试需要真实建表/迁移，默认 5s 不够）。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 迁移 + 角色创建会写同一个数据库；并行跑会互相打断，串行更接近真实部署。
    fileParallelism: false,
  },
});
