/**
 * 回执存储：`commandId` → 回执，以及**重复命令的业务幂等判定**。
 *
 * 与 `jti` 的分工（tech-design-v1 §3.1 的重试规则）：
 * - `jti` 防重放：同一枚凭证只能消费一次，重试必须重新签发（新 `jti`）。
 * - `commandId` 管业务幂等：同一条命令重试时 `commandId` 不变，返回 `duplicate`。
 *
 * 两者**不混用**，因此这里既要能认出"同一条命令的重试"，又必须拒绝
 * "同一个 commandId 换了操作/会话/正文"的请求 —— 后者不是重试，是伪造或
 * 路由 bug，必须显式报错而不是悄悄返回旧回执。
 *
 * @module @myrix/runtime-driver/receipts
 */
import type { CommandReceipt } from './types'

/** 一条已记录命令的原始形状；用于与重复请求逐项比对。 */
export interface ReceiptRecord {
  readonly commandId: string
  readonly op: string
  readonly sid: string
  /** 请求体摘要（`bh` claim 的值）。 */
  readonly bh: string
  readonly bootId: string
  /** 记录时刻（Unix 毫秒）。 */
  readonly at: number
}

/** 重复命令的比对结果。 */
export type DuplicateVerdict =
  | { readonly kind: 'retry'; readonly receipt: CommandReceipt }
  | { readonly kind: 'conflict'; readonly reason: string }

/**
 * 进程内回执表。
 *
 * 有界：超过上限时按插入顺序淘汰最旧记录。淘汰只会让跨重启/长期重试
 * 退化为"重新执行一次"（DSH 侧另有会话日志对账），不会放行未授权请求。
 */
export class ReceiptStore {
  private readonly records = new Map<string, ReceiptRecord>()

  constructor(private readonly capacity: number = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('myrix: 回执表容量必须是正整数')
    }
  }

  /** 已记录条数。 */
  get size(): number {
    return this.records.size
  }

  get(commandId: string): ReceiptRecord | undefined {
    return this.records.get(commandId)
  }

  /** 记录一条新命令的回执；重复写入同一 commandId 会被拒绝（调用方应先 `classify`）。 */
  put(record: ReceiptRecord): CommandReceipt {
    if (!this.records.has(record.commandId)) {
      if (this.records.size >= this.capacity) {
        const oldest = this.records.keys().next()
        if (!oldest.done) this.records.delete(oldest.value)
      }
      this.records.set(record.commandId, record)
    }
    return { status: 'accepted', commandId: record.commandId, bootId: record.bootId }
  }

  /**
   * 判定一条命令是否为重复。
   *
   * 只有 `op`/`sid`/`bh` **全部**一致才算重试；任何一项不同都是冲突。
   * 这正是"重复 commandId 必须比原 op/sid/hash"的落点。
   */
  classify(candidate: ReceiptRecord): DuplicateVerdict | undefined {
    const existing = this.records.get(candidate.commandId)
    if (existing === undefined) return undefined
    const mismatches: string[] = []
    if (existing.op !== candidate.op) mismatches.push(`op(${existing.op}≠${candidate.op})`)
    if (existing.sid !== candidate.sid) mismatches.push(`sid(${existing.sid}≠${candidate.sid})`)
    if (existing.bh !== candidate.bh) mismatches.push('bh(正文摘要不同)')
    if (mismatches.length > 0) {
      return {
        kind: 'conflict',
        reason: `commandId ${candidate.commandId} 已被不同的命令占用：${mismatches.join('、')}`,
      }
    }
    return {
      kind: 'retry',
      receipt: {
        status: 'duplicate',
        commandId: existing.commandId,
        bootId: existing.bootId,
        note: '同一条命令的重试：返回原回执，不重复执行',
      },
    }
  }

  /** 清空（进程重启/测试用）。 */
  clear(): void {
    this.records.clear()
  }
}
