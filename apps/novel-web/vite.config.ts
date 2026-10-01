import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * 前端只访问同源 BFF `/api/v1`。开发期用 Vite 代理把 /api 转发到本地 BFF，
 * 这样浏览器侧仍是同源请求（cookie 与 Origin 都由浏览器按同源规则发送），
 * 不会出现跨站 cookie 或自签身份头。生产由 BFF 同源托管 dist/。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const bffOrigin = (env.VITE_BFF_ORIGIN ?? "http://127.0.0.1:8787").replace(/\/$/, "");

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@myrix/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: Number(env.VITE_PORT ?? 5273),
      proxy: {
        "/api": {
          target: bffOrigin,
          changeOrigin: false,
          // SSE 需要关闭代理缓冲/超时干预，见 BFF `GET /sessions/:id/events`。
          ws: false,
        },
      },
    },
    preview: {
      port: Number(env.VITE_PORT ?? 5273),
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
