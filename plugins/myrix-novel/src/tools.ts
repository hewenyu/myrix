/**
 * `@myrix/novel` 的工具定义层。
 *
 * 六个工具的 **strict 参数 schema** 直接取自 `protocol.ts` 的 `toolParameters()`，
 * 作为 **raw JSON Schema** 交给 `ctx.tools.register()`（`additionalProperties: false`
 * 原样投影给模型）。要特别说明为什么不用 `defineTool()`：
 *
 * - `defineTool` 接受的是 dsh-tools 的 **author DSL**，它会把节点重新编译成
 *   raw JSON Schema。实测（`tests/poc/.dsh-install` 里锁定的 0.2.0-rc.2）：
 *   `parameters` 里的 `maxLength`/`minimum` 之类关键字会被
 *   `UNSUPPORTED_SCHEMA` 拒绝，而 dsh-tools **不会**用参数 schema 校验模型实参
 *   （`tools.execute()` 把 `arguments` 原样交给工具）。于是"schema 里写约束"
 *   在本版本上**不构成强制**。
 * - 因此本模块用 raw schema 投影给模型，并在 `execute` 里用
 *   `parseToolArguments()` 做**执行路径上的强校验**：多余字段（= 模型试图注入
 *   tenant/workId/sessionId/URL/凭据）直接拒绝，`expectedVersion` 必须是合法
 *   非负整数，文本长度与 ID 形状都在这里拦下 —— 且发生在**任何网络调用之前**。
 *
 * 工具**不接受**任何身份参数：workId/owner/tenant 由作品服务按会话绑定查库。
 *
 * @module @myrix/novel/tools
 */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PrincipalRegistry } from '@myrix/principals'
import {
  NOVEL_TOOLS,
  TOOL_DESCRIPTIONS,
  parseToolArguments,
  toolParameters,
  type NovelToolName,
  type ToolArguments,
} from './protocol.ts'
import { OUTPUT_SCHEMAS, projectToolOutput } from './output.ts'
import type { NovelCallPrincipal, NovelStoreService } from './service.ts'

/**
 * 取出本次调用所属的**可信**身份。
 *
 * 取法只有一条：以 `exec.agent` 为键走 `principals.require()`（严格路径：绑定 +
 * 撤权 + 活性；未安装活性提供者即拒绝）。失败抛出可安全外发的拒绝原因。
 *
 * **绝不**从 `args` 里读身份：模型可以伪造任何它自己写进 JSON 的字段。
 *
 * @throws PrincipalDeniedError（来自 @myrix/principals）当身份缺失/已撤权/活性未知。
 */
export function principalFor(principals: PrincipalRegistry, exec: { readonly agent?: unknown }): {
  readonly sessionId: string
  readonly revision: number
  readonly workId: string
} {
  const principal = principals.require(exec.agent as never)
  return { sessionId: principal.sid, revision: principal.rev, workId: principal.wid }
}

/** 工具返回的 canonical value：作品服务 `{ result }` 经**窄化投影**后的结果。 */
export type NovelToolOutput = Record<string, unknown> | readonly Record<string, unknown>[]

/** 工具执行依赖：作品服务客户端 + 身份表。两者都由装配注入，模型无法覆盖。 */
export interface NovelToolDeps {
  readonly store: NovelStoreService
  readonly principals: PrincipalRegistry
}

/**
 * 构造一个真实 `ToolDefinition`。
 *
 * `execute` 的顺序是刻意的：
 *   1. 以可信 Agent 取 principal（缺身份/撤权/活性未知 → 立即拒绝）；
 *   2. `parseToolArguments()` 强校验模型参数 —— 多余字段（身份注入）与非法版本
 *      在这一步失败，**先于任何网络 I/O**；
 *   3. 只把 `{sessionId, revision}` 交给作品服务；workId/owner/preset 由服务端核验；
 *   4. 把服务返回的**存储层记录**经 `projectToolOutput()` 窄化成声明 schema 的形状。
 *      这一步是必须的：作品服务返回 `SaveResult`（含 contentHash/updatedAt/reason）
 *      或含 tenantId/parentVersion 的章节记录，而 DSH 会真的按 `output.schema`
 *      校验 canonical value（additionalProperties:false），不投影就会抛
 *      `INVALID_TOOL_OUTPUT` 并把真实链路断在工具返回处。
 *
 * 注意第 2 步不接受 `principal.workId`：作品 id **不发给作品服务**（URL 里没有它），
 * 服务端从会话绑定里取。`principalFor()` 返回 workId 只用于系统提示注入。
 */
export function defineNovelTool(deps: NovelToolDeps, name: NovelToolName): ToolDefinition {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    // raw JSON Schema：原样投影，且额外字段被模型侧看到是禁止的。
    parameters: toolParameters(name),
    output: {
      schema: OUTPUT_SCHEMAS[name],
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async (rawArgs: unknown, exec: ToolRunContext): Promise<unknown> => {
      const principal = principalFor(deps.principals, exec)
      const args: ToolArguments = parseToolArguments(name, rawArgs)
      const call: NovelCallPrincipal = { sessionId: principal.sessionId, revision: principal.revision }
      const payload = await deps.store.call(call, name, args, exec.signal)
      return projectToolOutput(name, JSON.parse(payload) as unknown)
    },
  }
}

/** 一次构造多个工具定义（各 preset 只取自己 allowlist 里的那些）。 */
export function defineNovelTools(deps: NovelToolDeps, names: readonly NovelToolName[]): ToolDefinition[] {
  return names.map((name) => defineNovelTool(deps, name))
}

/** 校验一组工具名都在六个之内；装配时调用，未知名字直接抛错（fail-closed）。 */
export function assertKnownTools(names: readonly string[]): asserts names is readonly NovelToolName[] {
  for (const name of names) {
    if (!NOVEL_TOOLS.some((known) => known === name)) throw new Error(`myrix-novel: 未知的小说工具 ${name}`)
  }
}
