/**
 * 真实 DSH smoke：把 `plugins/myrix-llm-gateway` 作为**正常插件行**挂进锁定版
 * DSH 的 Cordis 树（走真实的 `apply` + fail-closed 校验 + `ctx.llm.registerAdapter`），
 * 用**真实 agent loop** 与**真实压缩引擎**发起模型调用，上游指向测试进程里另起的
 * loopback fake 网关（`tests/fake-gateway.ts`，OpenAI **Responses** 协议）。
 *
 * 这不是"伪 LLM"：链路里除了"模型网关"这个外部对端之外全是真件 —— 真 Cordis、
 * 真 Loader、真 `dsh-llm` 注册表、真 `dsh-agent-loop`、真 `dsh-compaction-basic`、
 * 真 `@myrix/principals`、真 HTTP/SSE。判定标准是**到达网关的真实 HTTP 请求**，
 * 而不是模型输出文本。
 *
 * ## 与生产一致的装载方式（不再依赖 Node 的 TS 开关）
 *
 * profile 里的插件是**编译后的 ESM**，由仓库已有的 `esbuild` 现场编译（未新增任何
 * 依赖、未改 lockfile）。子进程因此是一个普通 Node 进程：不需要
 * `--experimental-transform-types`，也就不会有"测试用 TS 开关跑通、生产编译后行为
 * 不同"的假绿（见 `docs/implementation/runtime-poc.md` R20）。
 *
 * ## 进程边界（不把环境变量当传声筒）
 *
 * 子进程只继承**显式白名单**的操作系统变量（`PATH`/`HOME`/`TMPDIR`/代理等），
 * 外加本 smoke 明确构造的 DSH 变量。父进程的 `process.env` **不会**整体注入，
 * 因此本机可能存在的 `MYRIX_*` 秘密不会进入被测进程。
 *
 * ## 有界等待（不靠固定 sleep）
 *
 * 每次运行用**独立的 fixture `$DSH_HOME`**（`mkdtemp`），并发/重跑互不干扰；
 * 等待以"子进程结束"或"看门狗报告写盘后主动退出"为界，而不是等一个猜出来的时长。
 *
 * 用法（`tests/poc/.dsh-install` 必须先装好，见 docs/implementation/runtime-poc.md）：
 *   pnpm vitest run plugins/myrix-llm-gateway/tests/smoke.dsh.test.ts
 *
 * 缺安装时测试会**显式失败**并说明怎么装，而不是静默跳过 —— 否则"没跑"会被
 * 误读成"通过"。
 *
 * @module @myrix/llm-gateway/tests/smoke.dsh
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DONE,
  FakeGateway,
  completed,
  created,
  itemAdded,
  itemDone,
  json,
  messageItem,
  sse,
  textDelta,
  textDone,
} from './fake-gateway.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const REPO = resolve(PLUGIN, '..', '..')
const BASE_BUNDLE = join(REPO, 'bundles', 'myrix-base')
const INSTALL = join(REPO, 'tests', 'poc', '.dsh-install')
const PROFILE = 'myrix-llm-gateway-smoke'

const TOKEN = 'smoke-cell-token-0123456789'
const MODEL = 'myrix-chat'

/** 定位锁定版 DSH CLI；找不到就抛（不跳过）。 */
function resolveDshCli(): { cli: string; version: string; nodeModules: string } {
  const candidates = [
    process.env.MYRIX_DSH_CLI,
    join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const installRoot = dirname(dirname(candidate))
    const manifest = join(installRoot, 'package.json')
    const version = existsSync(manifest)
      ? (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
      : 'unknown'
    return { cli: candidate, version, nodeModules: join(INSTALL, 'node_modules') }
  }
  throw new Error(
    'myrix-llm-gateway smoke: 找不到锁定版 DSH CLI。\n'
    + `期望位置：${join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')}\n`
    + '安装方式见 docs/implementation/runtime-poc.md §1（cd tests/poc/.dsh-install && pnpm install），'
    + '或用 MYRIX_DSH_CLI 指向 @deepseek-ai/dsh/lib/bin.js。',
  )
}

/**
 * 用仓库已有的 esbuild 把一个插件编译成单文件 ESM。
 *
 * `@deepseek-ai/*` 保持 external（保证只有一个 Cordis 实例），`@myrix/principals`
 * 内联（纯 TS 库，不引入第二个 Cordis 服务）。这正是真实镜像的构建步骤。
 */
function compilePlugin(pak: string, outFile: string): void {
  const esbuild = join(REPO, 'node_modules', '.bin', 'esbuild')
  if (!existsSync(esbuild)) {
    throw new Error(
      `myrix-llm-gateway smoke: 找不到 esbuild（${esbuild}）。`
      + '它随仓库工具链（vitest/vite）一起安装，请先在仓库根目录跑 pnpm install。',
    )
  }
  execFileSync(esbuild, [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    '--external:@deepseek-ai/*',
    `--alias:@myrix/principals=${join(REPO, 'plugins', 'myrix-principals', 'src', 'index.ts')}`,
    `--outfile=${outFile}`,
    '--log-level=warning',
    join(REPO, 'plugins', pak, 'src', 'index.ts'),
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 子进程环境：**操作系统变量白名单** + 显式 DSH 变量。
 *
 * 刻意不整体继承 `process.env`：父进程里可能存在的 `MYRIX_*`/模型密钥不应该
 * 因为"测试跑起来了"就流进被测进程。这里列出的都是与凭据无关的运行期变量。
 */
const OS_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const

function dshEnv(home: string, version: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of OS_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_RUNTIME_VERSION: version,
    ...extra,
  }
}

/**
 * 探针插件源码：只驱动真实 agent loop / 真实压缩引擎，并把会话侧事实写回报告。
 * 适配器由 `myrix-llm-gateway` 行按真实路径装配 —— 探针不直接 new 它。
 *
 * 探针是**编译后加载**的 `.mjs`（见 `prepareHome`），因此这里用普通 ESM 写。
 */
const PROBE_SOURCE = String.raw`
import { readFileSync, writeFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'myrix-llm-gateway-probe'
// 关键：ctx.agents 只是注册表，真正的 AgentFactory 由 dsh-agent-loop 提供
// （vendor 文档 R14：漏挂 agent-loop 时 create() 会在第一次建会话才失败）。
// 因此这里显式注入 agentLoop，让 profile 里该行先就位。
export const inject = [
  'cmdlineArgs', 'appExit', 'appReady', 'agents', 'agentLoop', 'agentPresets', 'llm',
  'principals', 'sessions', 'compaction',
]

export function apply(ctx, config) {
  // 阶段标记：探针卡在哪一步，报告旁的 .phase 文件里就能看到
  // （比等 spawn 超时便宜得多）。
  function mark(phase) {
    try {
      writeFileSync(config.out + '.phase', String(phase) + '\n', { flag: 'a' })
    } catch (error) {
      void error
    }
  }
  mark('apply')
  // 全程事件日志：无论卡在哪一步，看门狗都能把"已经发生了什么"写下来。
  const eventLog = []
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' && event.type !== 'assistant/attempt' && event.type !== 'assistant/message' && event.type !== 'request/header') return
    eventLog.push({
      type: event.type,
      sid: String(session.id),
      reason: event.type === 'turn/end' ? (event.data?.reason?.kind ?? null) : undefined,
      error: event.type === 'turn/end' ? String(event.data?.reason?.error?.message ?? '') : undefined,
      failure: event.type === 'assistant/attempt' ? String(event.data?.failure?.message ?? '') : undefined,
      code: event.type === 'assistant/attempt' ? (event.data?.failure?.code ?? null) : undefined,
    })
  })
  // 生产里"此刻仍是成员"由 myrix-runtime-driver 依据控制面状态安装；
  // 本探针里把 driver 的这一半替成一个显式判定。**注意**：没有它时
  // principals.requireBySession 一律拒绝（fail-closed），下面的 main 场景
  // 就会以 liveness-unavailable 失败 —— 这正是我们想要的默认行为。
  ctx.effect(() => ctx.principals.setLiveness(principal => principal.tid === 't_smoke'))

  // 报告写盘并退出：**唯一**的正常收工路径。
  function settle(report) {
    try {
      writeFileSync(config.out, JSON.stringify(report, null, 2))
    } catch (error) {
      void error
    }
    if (typeof ctx.appExit === 'function') {
      try { ctx.appExit(0) } catch (error) { void error }
    }
    process.exit(0)
  }

  ctx.effect(() => ctx.appReady?.onReady?.(() => {
    mark('ready')
    // 看门狗：真实 DSH 里任何一步卡住，也要把**已经观察到的事实**写盘并退出，
    // 而不是让外围等到超时、什么诊断都拿不到。它是**兜底**，不是等待手段：
    // 正常路径由 settle() 主动结束进程，外围只等"进程结束"这一个事件。
    setTimeout(() => {
      try {
        writeFileSync(config.out, JSON.stringify({
          ok: false,
          hung: true,
          phase: readFileSync(config.out + '.phase', 'utf8'),
          events: eventLog,
        }, null, 2))
      } catch (error) { void error }
      process.exit(3)
    }, config.watchdogMs ?? 45000)
    void run()
  }))

  // 顺序问题：Cordis 的注入只保证"服务名存在"，而 agents.setFactory() 是
  // agent-loop 构造函数里注册的 effect，要等 fiber 提交后才生效。真实 driver
  // 建会话发生在启动很久之后，不会遇到这个窗口；探针紧贴启动，所以要在这里
  // 等到工厂可用（NO_FACTORY 是**可重试的启动竞态**，不是业务失败）。
  async function createWithFactoryRetry(options) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        mark('create-attempt-' + String(attempt))
        return await ctx.agents.create(options)
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        mark('create-failed-' + String(attempt) + ':' + message.slice(0, 60))
        if (!message.includes('no agent factory registered')) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    mark('factory-timeout')
    throw new Error('agent factory 在 10s 内没有就位')
  }

  async function openSession(sid, rev, bind) {
    let unbind
    const handle = await createWithFactoryRetry({
      sessionId: sid,
      meta: { agentPreset: 'myrix-empty' },
      agentOptions: { provider: config.provider, model: config.model },
      setup: async (agentCtx, agent) => {
        await ctx.agentPresets.mount(agentCtx, 'myrix-empty')
        return {
          commit() {
            if (bind) {
              unbind = ctx.principals.bind(agent, {
                sid: sid, tid: 't_smoke', sub: 'u_smoke', wid: 'w_smoke', preset: 'myrix-empty', rev: rev,
              })
            }
          },
        }
      },
    })
    return { handle: handle, unbind: function () { if (unbind) unbind() } }
  }

  async function run() {
    const report = { ok: false }
    report.services = {
      appExit: typeof ctx.appExit,
      agents: ctx.get('agents') !== undefined,
      agentLoop: ctx.get('agentLoop') !== undefined,
      llm: ctx.get('llm') !== undefined,
      principals: ctx.get('principals') !== undefined,
      compaction: ctx.get('compaction') !== undefined,
    }
    const mainSid = 'smoke_main_' + String(Date.now())
    let unboundReport = null
    let compactionReport = null
    try {
      report.notes = []
      mark('run-start')
      mark('creating-main')
      const main = await openSession(mainSid, 9, true)
      mark('main-created')
      report.notes.push('main-created')
      main.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '写一句话' }], source: { kind: 'user' } }))
      mark('main-followup')
      await main.handle.agent.whenIdle()
      mark('main-idle')
      await ctx.sessions.flush(main.handle.agent.session)
      report.notes.push('main-idle turnEnd=' + JSON.stringify(main.handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => String(event.data?.reason?.kind ?? null) + ':' + String(event.data?.reason?.error?.message ?? ''))))
      report.main = {
        assistantMessages: main.handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length,
        turnEnd: main.handle.agent.session.snapshotEvents()
          .filter(event => event.type === 'turn/end')
          .map(event => event.data?.reason?.kind ?? null),
        turnEndError: main.handle.agent.session.snapshotEvents()
          .filter(event => event.type === 'turn/end')
          .map(event => String(event.data?.reason?.error?.message ?? '')),
      }
      main.unbind()
      await main.handle.dispose()

      if (config.scenario === 'main-only') return settle(report)

      const unboundSid = 'smoke_unbound_' + String(Date.now())
      const unbound = await openSession(unboundSid, 9, false)
      unbound.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '无身份' }], source: { kind: 'user' } }))
      await unbound.handle.agent.whenIdle()
      await ctx.sessions.flush(unbound.handle.agent.session)
      unboundReport = {
        assistantMessages: unbound.handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length,
        attempts: unbound.handle.agent.session.snapshotEvents()
          .filter(event => event.type === 'assistant/attempt')
          .map(event => event.data?.failure?.code ?? null),
      }
      await unbound.handle.dispose()

      const compactSid = 'smoke_compact_' + String(Date.now())
      const compact = await openSession(compactSid, 4, true)
      for (let index = 0; index < 3; index += 1) {
        compact.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '第 ' + String(index) + ' 轮内容' }], source: { kind: 'user' } }))
        await compact.handle.agent.whenIdle()
      }
      await ctx.sessions.flush(compact.handle.agent.session)
      let outcome = null
      let compactionError = null
      try {
        const result = await ctx.get('compaction').compactNow(compact.handle.agent, new AbortController().signal)
        outcome = result === null ? 'no-op' : 'compacted'
      } catch (error) {
        // 引擎的**可读业务原因**（例如摘要不够小）与归因/协议失败必须区分开：
        // 前者说明辅助调用确实发出去了，后者才是本插件的问题。
        outcome = 'engine-refused'
        compactionError = String(error?.message ?? error)
      }
      compactionReport = { outcome: outcome, error: compactionError }
    } catch (error) {
      report.failure = String(error?.stack ?? error)
    }
    report.unbound = unboundReport
    report.compaction = compactionReport
    report.ok = report.failure === undefined
    report.events = eventLog
    settle(report)
  }
}
`

/**
 * 铺设一个真实布局的 profile（插件物理位于 profile 内，`profiles/node_modules` 铺好）。
 *
 * 每个用例一个**独立 fixture `$DSH_HOME`**（临时目录），因此并发/顺序用例
 * 不会互相删掉对方的报告，也不会撞上机器上已有的 `~/.dsh`。
 */
function prepareHome(options: {
  home: string
  gatewayURL: string
  out: string
  withToken?: boolean
  scenario?: 'full' | 'main-only'
  watchdogMs?: number
}): void {
  const home = options.home
  const profileDir = join(home, 'profiles', PROFILE)
  const scoped = join(profileDir, 'node_modules', '@myrix')
  mkdirSync(scoped, { recursive: true })
  mkdirSync(join(profileDir, 'plugins'), { recursive: true })
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const install = resolveDshCli()
  symlinkSync(install.nodeModules, join(home, 'profiles', 'node_modules'), 'dir')
  symlinkSync(BASE_BUNDLE, join(scoped, 'dsh-bundle-myrix-base'), 'dir')

  // 真实部署的布局：插件是**编译后的 JS**，物理位于 profile 目录之内，
  // 它们的裸导入从 `$DSH_HOME/profiles/node_modules` 解析。
  const gatewayDir = join(profileDir, 'node_modules', '@myrix', 'llm-gateway')
  mkdirSync(gatewayDir, { recursive: true })
  compilePlugin('myrix-llm-gateway', join(gatewayDir, 'index.mjs'))
  writeFileSync(join(gatewayDir, 'package.json'), `${JSON.stringify({
    name: '@myrix/llm-gateway',
    private: true,
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2)}\n`)

  const principalsDir = join(profileDir, 'node_modules', '@myrix', 'principals')
  mkdirSync(principalsDir, { recursive: true })
  compilePlugin('myrix-principals', join(principalsDir, 'index.mjs'))
  writeFileSync(join(principalsDir, 'package.json'), `${JSON.stringify({
    name: '@myrix/principals',
    private: true,
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
  }, null, 2)}\n`)

  writeFileSync(join(profileDir, 'plugins', 'probe.mjs'), PROBE_SOURCE, { flag: 'w' })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    dsh: { profile: { bundles: ['@myrix/dsh-bundle-myrix-base'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# Generated by plugins/myrix-llm-gateway/tests/smoke.dsh.test.ts — do not edit.',
    '- insert:',
    '    # 身份表先挂：适配器与探针都硬依赖 ctx.principals（缺它不激活）。',
    '    - id: myrix-principals',
    '      name: ./node_modules/@myrix/principals/index.mjs',
    '    # 被测插件：走真实 apply + fail-closed 校验 + ctx.llm.registerAdapter。',
    '    - id: myrix-llm-gateway',
    '      name: ./node_modules/@myrix/llm-gateway/index.mjs',
    '      config:',
    `        baseURL: ${JSON.stringify(options.gatewayURL)}`,
    ...options.withToken === false ? [] : [`        cellToken: ${JSON.stringify(TOKEN)}`],
    '        providers: [myrix-gateway]',
    `        models: [${MODEL}]`,
    '        contextWindow: 100000',
    '    - id: myrix-llm-gateway-probe',
    '      name: ./plugins/probe.mjs',
    '      config:',
    `        out: ${JSON.stringify(options.out)}`,
    '        provider: myrix-gateway',
    `        model: ${MODEL}`,
    `        scenario: ${options.scenario ?? 'full'}`,
    `        watchdogMs: ${String(options.watchdogMs ?? 45_000)}`,
    '',
  ].join('\n'))
}

/**
 * 驱动一次真实 DSH 进程。
 *
 * **必须异步**：fake 网关跑在本进程的事件循环里；用 `spawnSync` 会把它整段
 * 阻塞住，子进程连得上 socket 却永远等不到响应。
 *
 * 等待以"子进程结束"为界 —— 正常路径由探针在报告写盘后主动退出，异常路径由
 * 探针自己的看门狗写盘后退出；外围的 kill 只是最后兜底，不是计时手段。
 *
 * @param home - 本次运行的 `$DSH_HOME`。
 * @param timeoutMs - 兜底杀进程的上限（默认 90s，比探针看门狗宽）。
 * @returns 退出码与输出。
 */
function bootDsh(home: string, timeoutMs = 90_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const install = resolveDshCli()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [install.cli, '--profile', PROFILE], {
      cwd: REPO,
      env: dshEnv(home, install.version),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: `${stderr}\nspawn error: ${error.message}` })
    })
  })
}

/** 读取探针报告；缺失时给出可诊断的失败信息。 */
function readReport(
  out: string,
  run: { status: number | null; stdout: string; stderr: string },
  phase: string,
): Record<string, unknown> {
  expect(
    existsSync(out),
    `DSH 没有产出报告（退出码 ${String(run.status)}）\nphase:\n${readPhase(phase)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  ).toBe(true)
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
}

/** 读阶段标记（可能不存在）。 */
function readPhase(phase: string): string {
  return existsSync(phase) ? readFileSync(phase, 'utf8') : '(none)'
}

/** 每个用例一个私有 fixture home；用完即删（除非 MYRIX_SMOKE_KEEP=1）。 */
const homes: string[] = []
function fixtureHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `myrix-smoke-${label}-`))
  homes.push(home)
  return home
}

/** 一个成功的 Responses 文本脚本。 */
function respondText(text: string): (context: { response: import('node:http').ServerResponse }) => void {
  return ({ response }) => {
    sse(response, [
      created(),
      itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
      textDelta(0, text),
      textDone(0, text),
      itemDone(0, messageItem(text)),
      completed({ usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, output: [messageItem(text)] }),
      DONE,
    ])
  }
}

describe('真实 DSH smoke：myrix-llm-gateway 接入锁定版 DSH（Responses 协议）', () => {
  it('普通对话与压缩辅助调用的真实 HTTP 请求都带正确归因；无身份会话被拒绝且不发请求', async () => {
    const gateway = await FakeGateway.start(respondText('好的。'))
    try {
      const home = fixtureHome('normal')
      const out = join(home, 'smoke-report.json')
      prepareHome({ home, gatewayURL: gateway.origin, out })
      const run = await bootDsh(home)
      const report = readReport(out, run, `${out}.phase`)

      expect(report.failure ?? null, `DSH 内探针失败：${String(report.failure ?? '')}`).toBeNull()
      expect(report.ok).toBe(true)

      // 1. 归因事实来自**到达 fake 网关的真实 HTTP 请求头**。
      expect(
        gateway.requests.length,
        `没有请求到达 fake 网关；探针报告：${JSON.stringify(report).slice(0, 2000)}`,
      ).toBeGreaterThan(0)
      const main = gateway.requests.filter(entry => entry.headers['x-myrix-session']?.startsWith('smoke_main_'))
      expect(main.length).toBeGreaterThan(0)
      for (const request of main) {
        expect(request.method).toBe('POST')
        expect(request.url).toBe('/v1/responses')
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
        expect(request.headers['x-myrix-revision']).toBe('9')
        expect(request.headers['x-myrix-cell-tenant']).toBe('t_smoke')
        expect(request.headers['x-myrix-purpose']).toBeUndefined()
        expect(request.body?.model).toBe(MODEL)
        expect(request.body?.stream).toBe(true)
        expect(request.body?.store).toBe(false)
        expect(request.body).not.toHaveProperty('messages')
        expect(request.body).not.toHaveProperty('stream_options')
      }

      // 2. 真实 agent loop 完成了对话：turn 正常结束，且落下了 assistant 消息。
      const mainReport = report.main as { assistantMessages: number; turnEnd: (string | null)[] }
      expect(mainReport.assistantMessages).toBeGreaterThan(0)
      expect(mainReport.turnEnd).toEqual(['completed'])

      // 3. 无身份会话：真实 DSH 里被拒绝，且**一个 HTTP 请求都没发**。
      expect(
        gateway.requests.some(entry => entry.headers['x-myrix-session']?.startsWith('smoke_unbound_')),
      ).toBe(false)
      const unbound = report.unbound as { assistantMessages: number; attempts: (string | null)[] } | null
      expect(unbound?.assistantMessages).toBe(0)
      expect(unbound?.attempts.length ?? 0).toBeGreaterThan(0)

      // 4. 压缩辅助调用：真实 compaction 引擎发出的请求带 purpose=compaction，
      //    且归因到压缩会话自己的 sessionId 与 rev。
      const compactionRequests = gateway.requests.filter(
        entry => entry.headers['x-myrix-session']?.startsWith('smoke_compact_'),
      )
      expect(compactionRequests.length).toBeGreaterThan(0)
      expect(compactionRequests.every(entry => entry.headers['x-myrix-revision'] === '4')).toBe(true)
      expect(compactionRequests.some(entry => entry.headers['x-myrix-purpose'] === 'compaction')).toBe(true)
      // 本 smoke 证明的是**辅助调用的归因**，不是"压缩一定收敛"：
      // fake 上游的摘要太短，真实引擎可能合理地报"无法产生更小的摘要"。
      // 因此这里接受 收敛 / 无需压缩 / 引擎可读拒绝 三种结果，
      // 但拒绝原因里**不得**出现归因或协议类失败。
      const compaction = report.compaction as { outcome: string | null; error: string | null } | null
      expect(['compacted', 'no-op', 'engine-refused']).toContain(compaction?.outcome ?? null)
      expect(compaction?.error ?? '').not.toContain('没有有效身份')
      expect(compaction?.error ?? '').not.toContain('INVALID')
      expect(compaction?.error ?? '').not.toContain('HTTP')
    } finally {
      await gateway.close()
    }
  }, 300_000)

  it('上游 503（未配置密钥）在真实 DSH 里表现为失败 attempt，而不是空回复', async () => {
    const gateway = await FakeGateway.start(({ response }) => {
      json(response, 503, { error: { message: '未配置上游密钥', type: 'service_unavailable', code: 'model_not_configured' } })
    })
    try {
      const home = fixtureHome('error')
      const out = join(home, 'smoke-report.json')
      prepareHome({ home, gatewayURL: gateway.origin, out, scenario: 'main-only' })
      const run = await bootDsh(home)
      const report = readReport(out, run, `${out}.phase`)

      // 适配器确实发出了请求（说明归因通过、失败发生在上游），
      // 但 DSH 侧不得出现 assistant 消息 —— 没有本地模拟、没有降级。
      expect(gateway.requests.length).toBeGreaterThan(0)
      expect(gateway.requests.every(entry => typeof entry.headers.authorization === 'string')).toBe(true)
      expect(gateway.requests.every(entry => entry.url === '/v1/responses')).toBe(true)
      const mainReport = report.main as {
        assistantMessages: number
        turnEnd: (string | null)[]
        turnEndError: string[]
      }
      expect(mainReport.assistantMessages).toBe(0)
      expect(mainReport.turnEnd).toEqual(['error'])
      // 失败原因来自适配器的分类与遮蔽后的上游文本，**不含** cell 令牌。
      expect(mainReport.turnEndError.join(' ')).toContain('HTTP 503')
      expect(mainReport.turnEndError.join(' ')).toContain('model_not_configured')
      expect(mainReport.turnEndError.join(' ')).not.toContain(TOKEN)
    } finally {
      await gateway.close()
    }
  }, 300_000)

  it('缺 cell 令牌 → 插件行不激活（fail-closed），不会出现无鉴权调用', async () => {
    const gateway = await FakeGateway.start(respondText('x'))
    try {
      const home = fixtureHome('nocred')
      const out = join(home, 'smoke-report.json')
      prepareHome({ home, gatewayURL: gateway.origin, out, withToken: false })
      const run = await bootDsh(home)

      // 插件必须启动即失败：DSH 报告该行未激活并给出可读原因，
      // 探针因此找不到 provider 路由，也不会有任何请求到达网关。
      expect(run.stderr).toContain('myrix-llm-gateway')
      expect(run.stderr).toContain('cell 服务令牌')
      expect(gateway.requests).toHaveLength(0)
      const report = readReport(out, run, `${out}.phase`)
      const main = report.main as { turnEnd: (string | null)[]; turnEndError: string[] }
      expect(main.turnEnd).toEqual(['error'])
      expect(main.turnEndError.join(' ')).toContain('no adapter registered for provider "myrix-gateway"')
    } finally {
      await gateway.close()
    }
  }, 300_000)
})

// 用完即删的 fixture home；`MYRIX_SMOKE_KEEP=1` 时保留现场便于排查。
process.on('exit', () => {
  if (process.env.MYRIX_SMOKE_KEEP === '1') return
  for (const home of homes) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定。
    }
  }
})
