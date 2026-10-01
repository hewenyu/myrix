/**
 * `plugins/myrix-novel` 测试用的真实 DSH 组合台。
 *
 * ## 什么是真的，什么是替身
 *
 * **真的**（全部来自锁定版本 `@deepseek-ai/dsh@0.2.0-rc.2`，与 vendor `639ed01` 同版本）：
 * `@deepseek-ai/dsh-tools` 注册表与 `tools.execute()` 执行管线、
 * `@deepseek-ai/dsh-agent-preset-registry`（`register` / `mount` / scope 隔离 / 实
 * Loader 子树）、`@deepseek-ai/cordis-plugin-loader`（preset 行真的经 Loader 装载）、
 * `@deepseek-ai/dsh-agent` + `dsh-agent-loop` 的真实 Agent 工厂、
 * `@deepseek-ai/dsh-system-prompt` 的段落装配、`@deepseek-ai/dsh-session`，
 * 以及 `@myrix/principals` 的**真实**身份表（含 `require*` 严格路径与撤权）。
 *
 * **替身**（明确标注，不冒充验收）：
 * - **模型**：`./stub-model.ts` 的无密钥适配器，路由名 `stub-model`。
 *   它只按脚本产出 chunk；**不证明**任何真实 provider/model 可用。
 * - **作品服务**：进程内 `fetch` 替身，回答形状合法的作品 JSON；**不证明** RLS、
 *   数据库权限或并发撤权安全（那些在 `apps/bff/tests/postgres.integration.test.ts`
 *   的真实 PostgreSQL 验收里）。
 * - **preset 行的模块解析**：真实部署写包名 `@myrix/novel/preset-tools`（由 profile
 *   的 `node_modules` 解析）。测试台把它注册成 Loader 内建 `cordis:myrix-novel-preset-tools`
 *   —— 与 DSH 自己 `cordis:group` 同一机制 —— 因为 vitest 进程没有 profile 解析根。
 *   默认包名本身由 `preset-module.test.ts` 断言。
 *
 * @module tests/harness
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PrincipalRegistry, type Principal } from '@myrix/principals'
import * as presetTools from '../src/preset-tools.ts'
import { StubModelAdapter } from './stub-model.ts'

/** 测试台给 preset 子插件起的 Loader 内建名。 */
export const PRESET_TOOLS_BUILTIN = 'myrix-novel-preset-tools'

/** 测试台使用的 preset 行模块说明符（真实部署用包名，见模块头注释）。 */
export const PRESET_TOOLS_SPECIFIER = `cordis:${PRESET_TOOLS_BUILTIN}`

/** 一次被记录的作品服务调用：只有可信身份与工具参数。 */
export interface RecordedCall {
  /** 请求路径里的会话 id（来自 principal.sid）。 */
  readonly sessionId: string
  readonly tool: string
  readonly args: unknown
  /** `x-myrix-revision` 请求头；必须等于 principal.rev。 */
  readonly revisionHeader: number
  /** 完整的请求路径，用于断言 workId 不出现在 URL 上。 */
  readonly path: string
  /** 该请求的 Authorization 头（应为 Bearer + Cell 凭据）。 */
  readonly authorization: string | null
}

/** 作品服务替身的可编程回答；默认给出形状合法的作品 JSON。 */
export interface WorksStub {
  readonly calls: RecordedCall[]
  /** 覆盖某个工具的回答；返回值成为 `{ result }` 的 `result`。 */
  answer(tool: string, result: unknown, status?: number): void
  /** 让下一个请求以给定状态码失败（用于错误保密断言）。 */
  fail(status: number, body?: string): void
}

export interface NovelHarness {
  readonly ctx: Context
  readonly works: WorksStub
  readonly adapter: StubModelAdapter
  readonly principals: PrincipalRegistry
  /**
   * 创建 Agent：真实 Loader 子树挂载 preset、安装真实 principal 绑定。
   *
   * @param options.coveredTools 覆盖 preset 行里的工具掩码（用于负例）。
   */
  createAgent(options: {
    sessionId: string
    preset: string
    principal: Principal
    /** 是否安装活性提供者；`false` 用于验证 fail-closed。默认 `true`。 */
    liveness?: boolean
    /** 覆盖注册的 preset 定义（例如故意写错掩码）。 */
    definitionOverride?: { id: string; plugins: readonly { id: string; name: string; config: Record<string, unknown> }[] }
  }): Promise<Agent>
  /** 释放整棵树；dispose 后所有注册都应消失。 */
  dispose(): Promise<void>
}

/**
 * 每个工具的默认回答，**刻意复刻作品服务的真实返回形状**。
 *
 * 这里不能只回"刚好符合工具输出 schema"的理想值：真实
 * `PostgresNovelRepository` 的保存类返回完整 `SaveResult`
 * （`packages/platform-store/src/repositories/results.ts`：`contentHash` /
 * `updatedAt` / `reason`），`getChapter` 返回 `ChapterRecord + text`
 * （含 `tenantId` / `parentVersion` / `contentHash` / `createdAt`）。
 * 替身若把这些内部字段提前抹掉，就会掩盖"真实执行器返回触发
 * `INVALID_TOOL_OUTPUT`"这一缺陷 —— 那正是本仓库曾经发生的回归。
 */
function defaultAnswer(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'get_outline':
      return { workId: 'w_1', text: '既有大纲', version: 3, updatedAt: '2026-09-30T00:00:00.000Z' }
    case 'get_chapter':
      return {
        tenantId: 't_1',
        id: typeof args['chapterId'] === 'string' ? args['chapterId'] : '10000000-0000-4000-8000-0000000000aa',
        workId: 'w_1',
        title: '第一章',
        text: '既有正文',
        version: 2,
        parentVersion: 1,
        contentHash: 'a'.repeat(64),
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      }
    case 'search_bible':
      return [{ id: '10000000-0000-4000-8000-0000000000bb', workId: 'w_1', kind: 'character', title: '主角', text: '设定正文', version: 1, updatedAt: '2026-09-30T00:00:00.000Z' }]
    case 'update_outline':
    case 'save_chapter_draft':
    case 'update_bible_entry':
      // 真实 SaveResult：含三个未声明的内部字段。
      return {
        status: 'saved',
        version: Number(args['expectedVersion'] ?? 0) + 1,
        contentHash: 'b'.repeat(64),
        updatedAt: '2026-09-30T00:00:00.000Z',
        reason: `expectedVersion(${String(args['expectedVersion'] ?? 0)}) 等于当前版本，追加为新版本`,
      }
    default:
      return { status: 'saved', version: 1 }
  }
}

/**
 * 装好一台真实组合。
 *
 * @returns harness；调用方负责 `await dispose()`。
 */
export async function createNovelHarness(): Promise<NovelHarness> {
  const ctx = new Context()
  ctx.baseUrl = new URL('../src/', import.meta.url).href

  const adapter = new StubModelAdapter()
  const answers = new Map<string, { result: unknown; status: number }>()
  let failure: { status: number; body: string } | undefined
  const calls: RecordedCall[] = []
  const works: WorksStub = {
    calls,
    answer(tool, result, status = 200) {
      answers.set(tool, { result, status })
    },
    fail(status, body = 'secret database URL') {
      failure = { status, body }
    },
  }

  const realFetch = globalThis.fetch
  const stubFetch = async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const segments = url.pathname.split('/')
    const tool = segments.at(-1) ?? ''
    const headers = new Headers(init?.headers)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({
      sessionId: decodeURIComponent(segments.at(-3) ?? ''),
      tool,
      args: body,
      revisionHeader: Number(headers.get('x-myrix-revision') ?? Number.NaN),
      path: url.pathname,
      authorization: headers.get('authorization'),
    })
    if (failure !== undefined) {
      const { status, body: text } = failure
      failure = undefined
      return new Response(text, { status })
    }
    const preset = answers.get(tool)
    if (preset !== undefined) return new Response(JSON.stringify({ result: preset.result }), { status: preset.status })
    return new Response(JSON.stringify({ result: defaultAnswer(tool, body) }))
  }
  globalThis.fetch = stubFetch as unknown as typeof fetch

  // ── 真实 DSH 内核 ────────────────────────────────────────────────────
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  // 等价于真实部署里 profile node_modules 对 `@myrix/novel/preset-tools` 的解析。
  ctx.loader.builtins[PRESET_TOOLS_BUILTIN] = presetTools as never
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'novel-chapter' })
  await ctx.plugin(PrincipalRegistry)
  // 明确的测试替身：唯一注册的模型路由，任何真实 provider 调用都会失败。
  ctx.llm.registerAdapter(['stub-model'], adapter as unknown as LlmAdapter)

  const principals = ctx.principals
  const registered: (() => Promise<void>)[] = []

  return {
    ctx,
    works,
    adapter,
    principals,
    async createAgent({ sessionId, preset, principal, liveness = true, definitionOverride }) {
      principals.setLiveness(liveness ? () => true : undefined)
      if (definitionOverride !== undefined) {
        registered.push(await ctx.agentPresets.register({
          id: definitionOverride.id,
          plugins: definitionOverride.plugins.map((row) => ({ id: row.id, name: row.name, config: row.config })),
        }))
      }
      const handle = await ctx.agents.create({
        sessionId: sessionId as never,
        meta: { agentPreset: preset },
        agentOptions: { provider: 'stub-model', model: 'stub-model-v1' },
        setup: async (agentCtx: Context, agent: Agent) => {
          await ctx.agentPresets.mount(agentCtx, preset)
          agentCtx.effect(() => principals.bind(agent, principal))
        },
      })
      return handle.agent
    },
    async dispose() {
      for (const dispose of registered.reverse()) await dispose()
      await ctx.fiber.dispose()
      globalThis.fetch = realFetch
    },
  }
}
