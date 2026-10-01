/**
 * Postgres/Kysely 装配入口（子路径导出 `@myrix/model-gateway/db`）。
 *
 * 为什么单独一个入口：运行期协议与端口（`@myrix/model-gateway`）不需要 `kysely`/`pg`，
 * 分开导出后，纯协议使用者不会被拖进数据库依赖。两边都不 re-export 对方。
 */
export * from "./schema";
export * from "./migrate";
export * from "./ledger";
export * from "./credentials";
