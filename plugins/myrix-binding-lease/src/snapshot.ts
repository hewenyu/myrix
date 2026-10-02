/**
 * 租约缓存：一份**当前有效的绑定快照** + 一个同步的六字段等值判定。
 *
 * 设计要点（都对应具体失败模式）：
 *
 * - **快照先完整解析，再一次性替换**。任何一步失败都不动旧缓存，而是显式
 *   `clear()` —— 半份快照比没有快照更危险（会把"没查到"当成"不在了"，
 *   或者反过来把不该放的主体留在表里）。
 * - **六个字段全比**。`sid` + `rev` 不足以保证是同一主体：同一 sid 换 `sub`
 *   意味着会话被换主、换 `wid` 意味着越权访问别的作品、换 `preset` 意味着
 *   挂了别的工具集、换 `tid` 意味着跨租户。任一不等即拒绝。
 * - **先 TTL 再 true**。租约过期后表里还有数据，但判定必须是 false；
 *   这是"有限时长"这个承诺的实现点。
 * - **不缓存响应正文**。只保留解析后的六元组，不保留原始 JSON 字符串、
 *   不保留响应头、不保留 token。
 *
 * @module @myrix/binding-lease/snapshot
 */

import type { Principal } from '@myrix/principals'
import type { BindingPolicy, BindingRow, BindingSnapshot, SnapshotRejection } from './types'

/** 解析成功的结果。 */
export interface ParsedSnapshot {
  readonly rows: readonly BindingRow[]
  /** 服务端下发的策略；缺省表示响应里没有该字段。 */
  readonly policy: BindingPolicy | undefined
}

/** 解析失败。 */
export interface ParseFailure {
  readonly rejection: SnapshotRejection
  readonly detail: string
}

export type ParseResult = { readonly ok: true; readonly snapshot: ParsedSnapshot } | { readonly ok: false; readonly failure: ParseFailure }

/** 单个字符串字段的长度上限（会话/用户/作品/preset id 都是短标识符）。 */
const MAX_FIELD_LENGTH = 256
/** 行数上限；与服务端 `snapshot_too_large` 的 10,000 条一致。 */
const MAX_ROWS = 10_000
/** 策略 `ttlMs` 的硬上限：策略与租约都不允许超过 30 秒。 */
export const MAX_POLICY_TTL_MS = 30_000

const ROW_FIELDS = ['sid', 'tid', 'sub', 'wid', 'preset', 'rev'] as const
const SNAPSHOT_FIELDS = ['cellId', 'tenantId', 'bindings', 'policy'] as const
const POLICY_FIELDS = ['rev', 'tools', 'ttlMs'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortString(value: unknown, _field: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_LENGTH) return undefined
  return value
}

/**
 * 解析并校验 `GET /internal/v1/cells/:cellId/bindings` 的响应体。
 *
 * `body` 已经是**有界读取**后的原始字节；这里再做一次纯函数校验，
 * 因此可以脱离网络被穷举测试。
 */
export function parseSnapshot(
  body: Uint8Array,
  expected: { readonly cellId: string; readonly tenantId: string },
): ParseResult {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应不是合法 UTF-8' } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应不是合法 JSON' } }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应必须是 JSON 对象' } }
  }

  const cellId = shortString(parsed['cellId'], 'cellId')
  if (cellId === undefined) {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应缺少合法的 cellId' } }
  }
  const tenantId = shortString(parsed['tenantId'], 'tenantId')
  if (tenantId === undefined) {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应缺少合法的 tenantId' } }
  }
  // 跨 cell / 跨租户不是"警告"，是拒绝：这份快照不属于本 cell。
  if (cellId !== expected.cellId) {
    return { ok: false, failure: { rejection: 'wrong-cell', detail: `快照 cellId(${cellId}) 与本 cell 配置不一致` } }
  }
  if (tenantId !== expected.tenantId) {
    return {
      ok: false,
      failure: { rejection: 'wrong-tenant', detail: `快照 tenantId(${tenantId}) 与本 cell 配置不一致` },
    }
  }

  const rawBindings = parsed['bindings']
  if (!Array.isArray(rawBindings)) {
    return { ok: false, failure: { rejection: 'malformed-json', detail: '响应缺少 bindings 数组' } }
  }
  if (rawBindings.length > MAX_ROWS) {
    // 服务端应当自己 503；真的收到了就说明对面截断或版本不匹配。
    return { ok: false, failure: { rejection: 'too-large', detail: `快照包含 ${rawBindings.length} 行，超过 ${MAX_ROWS} 上限` } }
  }

  // 顶层字段白名单：wire 漂移（多字段/改名）必须显式暴露，而不是被静默忽略。
  for (const key of Object.keys(parsed)) {
    if (!(SNAPSHOT_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, failure: { rejection: 'malformed-json', detail: `响应包含未知字段 ${key}` } }
    }
  }

  const policy = parsePolicy(parsed['policy'])
  if (policy !== undefined && !policy.ok) return { ok: false, failure: policy.failure }

  const rows: BindingRow[] = []
  const seen = new Set<string>()
  for (let index = 0; index < rawBindings.length; index += 1) {
    const raw = rawBindings[index]
    if (!isPlainObject(raw)) {
      return { ok: false, failure: { rejection: 'malformed-row', detail: `第 ${index} 行不是对象` } }
    }
    for (const key of Object.keys(raw)) {
      if (!(ROW_FIELDS as readonly string[]).includes(key)) {
        // 逐字段白名单：wire 漂移必须显式暴露，而不是被静默忽略。
        return { ok: false, failure: { rejection: 'malformed-row', detail: `第 ${index} 行包含未知字段` } }
      }
    }
    const sid = shortString(raw['sid'], 'sid')
    const rowTid = shortString(raw['tid'], 'tid')
    const sub = shortString(raw['sub'], 'sub')
    const wid = shortString(raw['wid'], 'wid')
    const preset = shortString(raw['preset'], 'preset')
    if (sid === undefined || rowTid === undefined || sub === undefined || wid === undefined || preset === undefined) {
      return { ok: false, failure: { rejection: 'malformed-row', detail: `第 ${index} 行缺少合法的身份字段` } }
    }
    const rev = raw['rev']
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
      return { ok: false, failure: { rejection: 'malformed-row', detail: `第 ${index} 行 rev 不是非负安全整数` } }
    }
    if (rowTid !== tenantId) {
      // 行级租户必须与快照租户一致：否则一行就能把主体带出本租户。
      return { ok: false, failure: { rejection: 'wrong-tenant', detail: `第 ${index} 行 tid 与快照 tenantId 不一致` } }
    }
    if (seen.has(sid)) {
      // 重复 sid 意味着服务端给了两份互相矛盾的记录；无法判断哪份是真的。
      return { ok: false, failure: { rejection: 'duplicate-sid', detail: `第 ${index} 行 sid 重复` } }
    }
    seen.add(sid)
    rows.push({ sid, tid: rowTid, sub, wid, preset, rev })
  }

  return { ok: true, snapshot: { rows, policy: policy?.ok === true ? policy.policy : undefined } }
}

/**
 * 解析可选的 `policy` 字段。
 *
 * 三条边界：**字段白名单**（wire 漂移显式失败）、**工具名白名单**（服务端只能
 * 在六个已知小说工具里收窄，出现别的名字说明对面版本不匹配）、**空数组是合法值**
 * （= 显式"什么都不允许"，绝不能与"没有策略"混为一谈）。
 */
export function parsePolicy(value: unknown): { ok: true; policy: BindingPolicy | undefined } | { ok: false; failure: ParseFailure } {
  if (value === undefined) return { ok: true, policy: undefined }
  if (!isPlainObject(value)) {
    return { ok: false, failure: { rejection: 'malformed-policy', detail: 'policy 必须是对象' } }
  }
  for (const key of Object.keys(value)) {
    if (!(POLICY_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, failure: { rejection: 'malformed-policy', detail: `policy 包含未知字段 ${key}` } }
    }
  }
  const rev = value['rev']
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
    return { ok: false, failure: { rejection: 'malformed-policy', detail: 'policy.rev 不是非负安全整数' } }
  }
  const ttlMs = value['ttlMs']
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_POLICY_TTL_MS) {
    return { ok: false, failure: { rejection: 'malformed-policy', detail: `policy.ttlMs 必须是 (0, ${MAX_POLICY_TTL_MS}] 内的安全整数` } }
  }
  const tools = value['tools']
  if (!Array.isArray(tools) || tools.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return { ok: false, failure: { rejection: 'malformed-policy', detail: 'policy.tools 必须是字符串数组' } }
  }
  const cleaned = [...new Set(tools as string[])]
  if (cleaned.some((name) => !NOVEL_TOOL_NAMES.has(name))) {
    // 服务端只被允许在六个已知工具里收窄；别的名字说明版本不匹配，按 malformed 拒绝。
    return { ok: false, failure: { rejection: 'malformed-policy', detail: 'policy.tools 含未知工具名' } }
  }
  return { ok: true, policy: Object.freeze({ rev, tools: Object.freeze(cleaned) as readonly string[], ttlMs }) }
}

/** 六个已知小说工具名；与 `@myrix/policy-enforcer` 的 allowlist 逐字一致。 */
const NOVEL_TOOL_NAMES = new Set([
  'get_outline',
  'update_outline',
  'get_chapter',
  'save_chapter_draft',
  'search_bible',
  'update_bible_entry',
])

/** 从解析结果构造 `BindingSnapshot`（测试与诊断用）。 */
export function toWireSnapshot(parsed: ParsedSnapshot, expected: { readonly cellId: string; readonly tenantId: string }): BindingSnapshot {
  return {
    cellId: expected.cellId,
    tenantId: expected.tenantId,
    bindings: parsed.rows,
    ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
  }
}

/**
 * 进程内租约缓存。
 *
 * 读路径（`lookup`）必须是**同步、无 I/O** 的：guard 在工具执行前同步调用它。
 * 因此所有网络与解析都在刷新路径上完成，这里只做 Map 查找与等值比较。
 */
export class LeaseCache {
  private present = false
  private entries: ReadonlyMap<string, BindingRow> = new Map()
  private installedAt = 0
  private expiresAt = 0
  private installs = 0
  private clears = 0
  private lastRejection: SnapshotRejection | null = null

  /**
   * 原子替换缓存。
   *
   * @param rows 已经完整校验过的行。
   * @param startedAt 本次请求**开始**的单调时刻：租约有效期从请求开始算，
   *   这样"下载慢"会直接吃掉有效期，而不是把过期时刻往后推。
   * @param ttlMs 租约时长。
   */
  install(rows: readonly BindingRow[], startedAt: number, ttlMs: number): void {
    const next = new Map<string, BindingRow>()
    for (const row of rows) next.set(row.sid, row)
    this.entries = next
    this.present = true
    this.installedAt = startedAt
    this.expiresAt = startedAt + ttlMs
    this.installs += 1
    this.lastRejection = null
  }

  /** 清空缓存；之后 `lookup` 一律 false。 */
  clear(rejection: SnapshotRejection | null, now: number): void {
    this.entries = new Map()
    this.present = false
    this.expiresAt = 0
    this.installedAt = now
    this.clears += 1
    this.lastRejection = rejection
  }

  /** 是否有未过期租约。 */
  active(now: number): boolean {
    return this.present && now < this.expiresAt
  }

  /**
   * 同步活性判定：先 TTL，再六字段全等。
   *
   * 任何异常路径（无快照、过期、字段缺失）都返回 false —— 这个函数**没有**
   * "无法判断所以放行"的分支。
   */
  lookup(principal: Principal, now: number): boolean {
    if (!this.present) return false
    if (now >= this.expiresAt) return false
    const row = this.entries.get(principal.sid)
    if (row === undefined) return false
    return (
      row.tid === principal.tid &&
      row.sub === principal.sub &&
      row.wid === principal.wid &&
      row.preset === principal.preset &&
      row.rev === principal.rev
    )
  }

  /** 当前快照行数（诊断用；不暴露主体）。 */
  size(): number {
    return this.present ? this.entries.size : 0
  }

  /** 诊断快照。 */
  state(now: number): {
    active: boolean
    bindings: number
    expiresAt: number | null
    installedAt: number | null
    installs: number
    clears: number
    lastRejection: SnapshotRejection | null
  } {
    return {
      active: this.active(now),
      bindings: this.size(),
      expiresAt: this.present ? this.expiresAt : null,
      installedAt: this.present ? this.installedAt : null,
      installs: this.installs,
      clears: this.clears,
      lastRejection: this.lastRejection,
    }
  }
}
