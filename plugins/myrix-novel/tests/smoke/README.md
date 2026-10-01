# `myrix-novel` 真实 DSH 冒烟

```sh
node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs
```

## 它做什么

1. 用 `tests/poc/lib/compile-plugins.mjs` 的**同一编译契约**把 `myrix-principals` 与
   `myrix-novel` 编译成单文件 ESM（`@deepseek-ai/*` 保持 external，全树一个 Cordis 实例）；
   preset 子插件 `@myrix/novel/preset-tools` 也编译成独立模块。
2. 在 `plugins/myrix-novel/tests/smoke/.work/` 自建一个 `$DSH_HOME` 与 profile：
   `profiles/node_modules` 软链到锁定安装，`node_modules/@myrix/novel/` 是一个**真实包**
   （带 `exports`），因此根插件的 preset 行用**默认包名**解析子插件 —— 与部署镜像同构。
3. 用**真实锁定 CLI**（`tests/poc/.dsh-install` 的 `dsh@0.2.0-rc.2`，vendor `639ed01`）启动，
   由 `smoke-app.mjs` 探针实测：服务已提供、三个 preset 未损坏、根作用域没有小说工具、
   每个 preset 的掩码正确、工具真的经 HTTP 打到作品服务、提示注入了服务端 workId。
4. 结束后删除 `.work/` 与 `.build/`，不留运行产物；退出码 = 探针是否全部通过。

## 不是什么

- **不是模型验收**：模型是 `smoke-mock-llm.mjs` 的无密钥替身。
- **不是作品服务验收**：作品服务是进程内 HTTP 替身。
- **不是 PostgreSQL/RLS/并发撤权验收**：那些在 `apps/bff/tests/postgres.integration.test.ts`。

## 前置

`tests/poc/.dsh-install` 必须已按 `docs/implementation/runtime-poc.md` 安装（缺失时脚本以退出码 2 明确报错，不会静默跳过）。
