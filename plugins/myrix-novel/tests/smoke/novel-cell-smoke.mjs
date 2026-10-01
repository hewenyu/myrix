/**
 * `myrix-novel` 真实锁定 DSH 冒烟。
 *
 * 把**编译后的**插件装进一个自建 `$DSH_HOME` 的 Cell profile，用真实
 * `dsh` 0.2.0-rc.2 CLI（vendor `639ed01` 发布物）启动，实测三件事：
 *
 *   1. 插件在真实 Loader 下装载：`ctx.novelStore` 可读、三个 preset 进 roster；
 *   2. 每个 preset 的 Agent 只看到自己掩码内的工具，根作用域没有小说工具；
 *   3. 工具 execute 真的经 HTTP 打到作品服务，结果回传，提示注入服务端 workId。
 *
 * 编译契约沿用 `tests/poc/lib/compile-plugins.mjs`：`@deepseek-ai/*` 保持 external
 * （全树只有一个 Cordis 实例），`@myrix/principals` 作为纯类型被 esbuild 擦除。
 * preset 行用**默认包名** `@myrix/novel/preset-tools`，经 profile 的
 * `node_modules` 解析 —— 与真实部署一致，不使用测试专用的模块说明符。
 *
 * **替身**：模型（`./smoke-mock-llm.mjs`，无密钥）与作品服务（进程内 HTTP 替身）。
 * 本冒烟**不是**模型验收，也**不是** PostgreSQL/RLS 验收。
 *
 * `tests/poc/**` 只读复用，不修改。
 *
 * 用法：node plugins/myrix-novel/tests/smoke/novel-cell-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')
const WORK = join(HERE, '.work')
/** 编译产物目录（与 $DSH_HOME 分开，避免被 home 清理连带删除）。 */
const BUILD = join(HERE, '.build')
const HOME = join(WORK, 'home')
const PROFILE = 'myrix-novel-smoke'
const INSTALL = join(REPO, 'tests', 'poc', '.dsh-install')
const CLI = join(INSTALL, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BASE_BUNDLE = join(REPO, 'bundles', 'myrix-base')

if (!existsSync(CLI)) {
  process.stderr.write(`myrix-novel-smoke: 找不到锁定 DSH CLI：${CLI}\n先按 docs/implementation/runtime-poc.md 安装。\n`)
  process.exit(2)
}

// ── 编译：两个入口（根插件 + preset 子插件） ────────────────────────────
const { compileCellPlugins } = await import(join(REPO, 'tests', 'poc', 'lib', 'compile-plugins.mjs'))
const outDir = BUILD
rmSync(outDir, { recursive: true, force: true })
const compiled = compileCellPlugins({ outDir, packages: ['myrix-principals', 'myrix-novel'], fresh: true })
const principalsBundle = compiled.bundles['myrix-principals']
if (!principalsBundle) {
  process.stderr.write('myrix-novel-smoke: 未产出 myrix-principals 编译产物\n')
  process.exit(2)
}
const rootBundle = compiled.bundles['myrix-novel']
if (!rootBundle) {
  process.stderr.write('myrix-novel-smoke: 未产出 myrix-novel 编译产物\n')
  process.exit(2)
}
// 子插件按同样的 external/alias 契约单独编译，成为可被 preset 行引用的模块。
const { execFileSync } = await import('node:child_process')
const presetBundle = join(outDir, 'myrix-novel-preset-tools.mjs')
execFileSync(compiled.esbuild, [
  '--bundle', '--platform=node', '--format=esm', '--target=node24',
  '--external:@deepseek-ai/*',
  `--alias:@myrix/principals=${join(REPO, 'plugins', 'myrix-principals', 'src', 'index.ts')}`,
  `--outfile=${presetBundle}`,
  '--log-level=warning',
  join(REPO, 'plugins', 'myrix-novel', 'src', 'preset-tools.ts'),
], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })

// ── 替身作品服务 ───────────────────────────────────────────────────────
const worksCalls = []
const works = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const tool = req.url.split('?')[0].split('/').at(-1)
    const args = body === '' ? {} : JSON.parse(body)
    worksCalls.push({ path: req.url, tool, args, revision: req.headers['x-myrix-revision'], auth: req.headers.authorization })
    const result = tool === 'get_outline'
      ? { workId: 'w_smoke', text: '冒烟大纲', version: 3, updatedAt: '2026-09-30T00:00:00.000Z' }
      : { status: 'saved', version: 4 }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result }))
  })
})
await new Promise(done => works.listen(0, '127.0.0.1', done))
const worksOrigin = `http://127.0.0.1:${works.address().port}`

// ── 组装 $DSH_HOME / profile（与部署镜像同构） ──────────────────────────
// 插件以**真实包**的形式安装：`node_modules/@myrix/novel` 带自己的 `exports`，
// 因此根插件的 preset 行可以用默认包名 `@myrix/novel/preset-tools` 解析 ——
// 这正是 `tests/poc/lib/cell-profile.mjs` 组装 Cell 的方式，也是本冒烟要证明的路径。
rmSync(WORK, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', PROFILE)
const novelPkg = join(profileDir, 'node_modules', '@myrix', 'novel')
mkdirSync(join(profileDir, 'plugins'), { recursive: true })
mkdirSync(novelPkg, { recursive: true })
symlinkSync(join(INSTALL, 'node_modules'), join(HOME, 'profiles', 'node_modules'), 'dir')
symlinkSync(BASE_BUNDLE, join(profileDir, 'node_modules', '@myrix', 'dsh-bundle-myrix-base'), 'dir')
writeFileSync(join(novelPkg, 'package.json'), `${JSON.stringify({
  name: '@myrix/novel',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: { '.': './index.mjs', './preset-tools': './preset-tools.mjs' },
}, null, 2)}\n`)
cpSync(rootBundle, join(novelPkg, 'index.mjs'))
cpSync(presetBundle, join(novelPkg, 'preset-tools.mjs'))
// 身份表与探针是 profile 内的行（与 PoC 的写法一致）。
cpSync(principalsBundle, join(profileDir, 'plugins', 'principals.mjs'))
cpSync(join(HERE, 'smoke-app.mjs'), join(profileDir, 'plugins', 'smoke-app.mjs'))
cpSync(join(HERE, 'smoke-mock-llm.mjs'), join(profileDir, 'plugins', 'smoke-mock-llm.mjs'))

writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: `dsh-profile-${PROFILE}`, private: true, version: '0.0.0', type: 'module',
  dsh: { profile: { bundles: ['@myrix/dsh-bundle-myrix-base'] } },
}, null, 2)}\n`)
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '# Generated by plugins/myrix-novel/tests/smoke — do not edit.',
  '- insert:',
  '    # 身份表先挂：本插件与探针都依赖 ctx.principals（缺它不激活）。',
  '    - id: myrix-principals',
  '      name: ./plugins/principals.mjs',
  '    - id: myrix-novel-smoke-mock-llm',
  '      name: ./plugins/smoke-mock-llm.mjs',
  '    # 被测插件：真实 apply，preset 行用默认包名 @myrix/novel/preset-tools。',
  '    - id: myrix-novel',
  "      name: '@myrix/novel'",
  '      config:',
  `        origin: ${JSON.stringify(worksOrigin)}`,
  `        credential: ${JSON.stringify('smoke-credential')}`,
  '    - id: myrix-novel-smoke-app',
  '      name: ./plugins/smoke-app.mjs',
  '      config:',
  `        out: ${JSON.stringify(join(WORK, 'smoke-report.json'))}`,
  '',
].join('\n'))

// 必须**异步**启动：替身作品服务跑在本进程里，spawnSync 会阻塞事件循环，
// 子进程的 HTTP 请求永远等不到响应（实测表现为 15s 超时、零请求到达）。
const booted = await new Promise(resolveBoot => {
  const child = spawn(process.execPath, [CLI, '--profile', PROFILE], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1', DSH_RUNTIME_VERSION: '0.2.0-rc.2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const killer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  child.on('close', status => {
    clearTimeout(killer)
    resolveBoot({ status, stdout, stderr })
  })
})
works.close()

const reportPath = join(WORK, 'smoke-report.json')
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
// 冒烟不留运行产物：报告已经读到内存，$DSH_HOME 与编译产物都可以删。
rmSync(WORK, { recursive: true, force: true })
rmSync(BUILD, { recursive: true, force: true })
process.stdout.write(`myrix-novel-smoke: dsh exit=${booted.status}\n`)
if (report === null) {
  process.stdout.write(`${booted.stdout}\n${booted.stderr}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify({ probes: report.probes, worksCalls }, null, 2)}\n`)
process.exit(report.probes.every(p => p.ok) ? 0 : 1)
