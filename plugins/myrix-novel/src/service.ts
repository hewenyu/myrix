/**
 * `@myrix/novel` 的公开服务契约：`ctx.novelStore`。
 *
 * 只声明**插件之间**用得到的那一个方法（`call`）。真实实现是
 * `NovelStoreClient`（HTTP + 严格参数校验）；测试与集成替身实现同一接口。
 *
 * 契约里没有 tenant/workId/URL/凭据：调用方只能给 `{sessionId, revision}`，
 * 其余由作品服务按数据库核验。
 *
 * @module @myrix/novel/service
 */
import type { NovelToolName } from './protocol.ts'

/** 一次工具调用所需的**最小**可信身份（来自服务端绑定的 Principal）。 */
export interface NovelCallPrincipal {
  readonly sessionId: string
  readonly revision: number
}

/**
 * 作品服务客户端契约。
 *
 * @returns 作品服务 `{ result }` 里 `result` 的 JSON 文本；冲突（HTTP 409）同样
 *   正常返回，交由模型看到 `{status:"conflict", version}` 而不是异常文本。
 */
export interface NovelStoreService {
  call(principal: NovelCallPrincipal, tool: NovelToolName, input: unknown, signal: AbortSignal): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    novelStore: NovelStoreService
  }
}
