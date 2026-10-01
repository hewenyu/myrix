/**
 * 纯函数准入内核：不做 I/O、不读时钟、不读进程状态。
 *
 * 之所以单独抽出来，是因为"为什么开/关"必须能被测试穷举（AGENTS.md 硬性规则 3）。
 * 判定链是有序的，顺序本身是安全属性：
 *
 *   1. 身份缺失/失效            → 拒绝（guard 的兜底职责）
 *   2. 静态 allowlist 未安装     → 拒绝（不允许"没配置就放行"）
 *   3. 工具不在静态 allowlist    → 拒绝
 *   4. 策略快照缺失              → 拒绝（网络失败/未下发都按拒绝）
 *   5. 快照过期                  → 拒绝
 *   6. 快照租户与主体租户不一致   → 拒绝
 *   7. 工具不在快照允许集合       → 拒绝
 *   8. 其余                      → 放行
 *
 * 两个集合取**交集**：快照只能收窄静态 allowlist，不能放宽它。这是
 * "合并类操作只能收窄"（AGENTS.md 规则 2）在本插件里的落点。
 *
 * @module @myrix/policy-enforcer/admission
 */
import type { AdmissionInput, PolicySnapshot, ToolAdmission } from './types'

/** 小说垂直业务允许模型看到的全部工具（platform-plan-v2 §5.2，仅 6 个）。 */
export const NOVEL_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  'get_outline',
  'update_outline',
  'get_chapter',
  'save_chapter_draft',
  'search_bible',
  'update_bible_entry',
])

/** 判定拒绝原因中允许出现的最大长度，避免把上游字符串原样放大。 */
const MAX_REASON = 240

function deny(reason: string): ToolAdmission {
  return { allow: false, reason: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason }
}

/**
 * 判定一次工具执行能否放行。
 *
 * 纯函数：同样的输入永远给同样的输出，因此"每个拒绝分支"都能被单测锁死。
 */
export function admitTool(input: AdmissionInput): ToolAdmission {
  const name = input.toolName
  if (typeof name !== 'string' || name.length === 0) {
    return deny('myrix: 工具名为空')
  }

  // 1. 身份：没有有效身份就没有一切。这是 guard 的兜底，业务工具自己还要再查一次。
  if (!input.principal.ok) {
    return deny(`myrix: 会话没有有效身份（${input.principal.reason}）：${input.principal.detail}`)
  }
  const principal = input.principal.principal

  // 2/3. 静态 allowlist。未安装（undefined 或空）一律拒绝：
  // "没有 allowlist" 与 "allowlist 为空" 都必须 fail-closed，不允许被当作"不限制"。
  const allowlist = input.allowedTools
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return deny('myrix: 未安装工具 allowlist，拒绝一切工具调用')
  }
  if (!allowlist.includes(name)) {
    return deny(`myrix: 工具 ${name} 不在授权 allowlist 内`)
  }

  // 4. 策略快照缺失即拒绝：网络失败、未下发、被撤下都走同一条路径。
  const snapshot: PolicySnapshot | undefined = input.snapshot
  if (snapshot === undefined) {
    return deny('myrix: 当前没有可用的策略快照，拒绝')
  }

  // 5. 过期即拒绝（半开区间：now === expiresAt 视为已过期）。
  if (!Number.isFinite(snapshot.expiresAt) || input.now >= snapshot.expiresAt) {
    return deny(`myrix: 策略快照已过期（rev=${String(snapshot.rev)}）`)
  }

  // 6. 快照必须属于本主体租户：跨租户快照等于没有快照。
  if (snapshot.tid !== principal.tid) {
    return deny('myrix: 策略快照的租户与本会话不一致，拒绝')
  }

  // 7. 快照收窄：交集判定。
  if (!Array.isArray(snapshot.tools) || !snapshot.tools.includes(name)) {
    return deny(`myrix: 工具 ${name} 未被当前策略快照允许（rev=${String(snapshot.rev)}）`)
  }

  return { allow: true }
}

/** 校验一份外部下发的快照形状；不合法直接抛错，让安装方 fail-closed。 */
export function assertPolicySnapshot(value: unknown): PolicySnapshot {
  if (value === null || typeof value !== 'object') throw new Error('myrix: 策略快照不是对象')
  const record = value as Record<string, unknown>
  const rev = record['rev']
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
    throw new Error('myrix: 策略快照缺 rev（非负安全整数）')
  }
  const tid = record['tid']
  if (typeof tid !== 'string' || tid.length === 0) throw new Error('myrix: 策略快照缺 tid')
  const expiresAt = record['expiresAt']
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('myrix: 策略快照缺 expiresAt（Unix 毫秒）')
  }
  const tools = record['tools']
  if (!Array.isArray(tools) || tools.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('myrix: 策略快照的 tools 必须是字符串数组')
  }
  return { rev, tid, expiresAt, tools: Object.freeze([...tools]) as readonly string[] }
}
