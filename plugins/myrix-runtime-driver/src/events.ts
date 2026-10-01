/**
 * SSE 事件中枢：**先订阅、再补发、按 seq 去重**，瞬态帧不补发。
 *
 * 语义取自 tech-design-v1 §3.3：
 * - 持久事件（`session/event`）带 `seq`，断线后可以按 `Last-Event-ID` 续传。
 * - 瞬态帧（`agent/assistant-stream`）**没有 seq**，只转发给此刻已连接的订阅者；
 *   断线后不补、也不进重放缓冲。
 *
 * 竞态处理是关键：如果在"读历史"之后才挂上实时订阅，中间到达的事件会丢。
 * 因此顺序固定为
 *   1) 把订阅者挂进实时集合（此后事件进入它的待发队列）
 *   2) 补发历史（seq > lastEventId）
 *   3) 冲刷待发队列，跳过 `seq <= 已发送水位` 的重复项
 *
 * 去重水位按订阅者各自维护，因此一次慢速重放不会影响其他订阅者。
 *
 * @module @myrix/runtime-driver/events
 */
import type { StreamEvent } from './types'
import type { SseSink } from './http'
import { encodeSseFrame } from './http'

/** 每个会话保留的持久事件上限（用于重放）；更旧的部分由 DSH 会话日志兜底。 */
export const DEFAULT_REPLAY_WINDOW = 2048

/** 一次订阅的准入回调：返回 false 即立刻关闭该连接（撤权/身份失效）。 */
export type SubscribeAdmission = () => boolean

/** 历史提供者：给会话当前已提交的持久事件（驱动从 DSH 会话日志取）。 */
export type HistoryProvider = (sid: string) => readonly StreamEvent[]

interface Subscriber {
  readonly sid: string
  readonly sink: SseSink
  readonly admit: SubscribeAdmission
  /** 已发送的最大 seq；`undefined` 表示还没有发送过任何持久事件。 */
  watermark: number | undefined
  /** 重放期间到达的实时帧，按到达顺序暂存。 */
  readonly pending: StreamEvent[]
  replaying: boolean
  closed: boolean
}

/** 订阅句柄；关闭时幂等。 */
export interface Subscription {
  close(): void
  readonly closed: boolean
}

/**
 * 单进程事件中枢。
 *
 * 有界缓冲：每个会话最多保留 `replayWindow` 条持久事件。超出后最旧的被丢弃，
 * 并在补发时先发一条 `myrix/truncated` 标记，让客户端知道"从这里往后可能不连续"，
 * 而不是静默给出一段有洞的流。
 */
export class EventHub {
  private readonly buffers = new Map<string, StreamEvent[]>()
  private readonly subscribers = new Set<Subscriber>()
  private history: HistoryProvider | undefined
  private published = 0
  private transient = 0
  private dropped = 0

  constructor(private readonly replayWindow: number = DEFAULT_REPLAY_WINDOW) {
    if (!Number.isSafeInteger(replayWindow) || replayWindow <= 0) {
      throw new Error('myrix: 重放窗口必须是正整数')
    }
  }

  /** 安装历史提供者（驱动注入：从会话日志读持久事件）。 */
  setHistoryProvider(provide: HistoryProvider | undefined): void {
    this.history = provide
  }

  /** 记录一条持久事件并转发；`seq` 必须是非负整数。 */
  publishDurable(sid: string, event: StreamEvent): void {
    if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) return
    const buffer = this.buffers.get(sid) ?? []
    buffer.push(event)
    if (buffer.length > this.replayWindow) {
      const excess = buffer.length - this.replayWindow
      buffer.splice(0, excess)
      this.dropped += excess
    }
    this.buffers.set(sid, buffer)
    this.published += 1
    for (const subscriber of this.subscribers) {
      if (subscriber.sid !== sid || subscriber.closed) continue
      this.deliver(subscriber, event)
    }
  }

  /** 转发一条瞬态帧（无 seq，不补发、不入缓冲）。 */
  publishTransient(sid: string, event: StreamEvent): void {
    if (typeof event.seq === 'number') return
    this.transient += 1
    for (const subscriber of this.subscribers) {
      if (subscriber.sid !== sid || subscriber.closed) continue
      if (!this.checkAdmission(subscriber)) continue
      subscriber.sink.write(encodeSseFrame({ type: event.type, data: event.data }))
    }
  }

  /** 发送心跳注释帧；调用方按空闲间隔调用。 */
  heartbeat(): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed) continue
      if (!this.checkAdmission(subscriber)) continue
      subscriber.sink.write(': hb\n\n')
    }
  }

  /**
   * 订阅一个会话的事件流。
   *
   * @param sid 会话 id。
   * @param lastEventId 客户端声明的续传水位（`Last-Event-ID`）；省略表示"只收新的"。
   * @param sink SSE 写入端。
   * @param admit 每次发送前的准入检查（撤权检查在这里发生）。
   */
  subscribe(
    sid: string,
    lastEventId: number | undefined,
    sink: SseSink,
    admit: SubscribeAdmission,
  ): Subscription {
    const subscriber: Subscriber = {
      sid,
      sink,
      admit,
      watermark: lastEventId,
      pending: [],
      replaying: true,
      closed: false,
    }
    // 1) 先挂实时订阅。
    this.subscribers.add(subscriber)

    // 2) 补发历史。
    const history = this.collectHistory(sid, lastEventId)
    for (const event of history) {
      if (subscriber.closed) break
      if (!this.deliver(subscriber, event)) break
    }

    // 3) 冲刷重放期间到达的实时帧，按 seq 去重。
    subscriber.replaying = false
    for (const event of subscriber.pending.splice(0)) {
      if (subscriber.closed) break
      if (!this.deliver(subscriber, event)) break
    }

    return {
      get closed() {
        return subscriber.closed
      },
      close: () => {
        this.closeSubscriber(subscriber)
      },
    }
  }

  /** 关闭某会话的全部订阅（撤权、drain、dispose 时调用）。 */
  closeSession(sid: string): number {
    let closed = 0
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.sid !== sid) continue
      this.closeSubscriber(subscriber)
      closed += 1
    }
    return closed
  }

  /** 关闭全部订阅。 */
  closeAll(): number {
    let closed = 0
    for (const subscriber of [...this.subscribers]) {
      this.closeSubscriber(subscriber)
      closed += 1
    }
    return closed
  }

  /** 丢弃某会话的重放缓冲（会话被撤权/删除后不再对外补发）。 */
  dropSession(sid: string): void {
    this.buffers.delete(sid)
  }

  /** 诊断指标：不含事件内容。 */
  stats(): { sessions: number; subscribers: number; published: number; transient: number; dropped: number } {
    return {
      sessions: this.buffers.size,
      subscribers: this.subscribers.size,
      published: this.published,
      transient: this.transient,
      dropped: this.dropped,
    }
  }

  // ---- 内部 ----

  private collectHistory(sid: string, lastEventId: number | undefined): readonly StreamEvent[] {
    const buffered = this.buffers.get(sid) ?? []
    const provided = this.history?.(sid) ?? []
    // 历史优先来自 DSH 会话日志（权威）；缓冲用于补上日志里还没有的部分。
    // 两者按 seq 合并去重，避免同一事件出现两次。
    const merged = new Map<number, StreamEvent>()
    for (const event of provided) {
      if (typeof event.seq === 'number') merged.set(event.seq, event)
    }
    for (const event of buffered) {
      if (typeof event.seq === 'number' && !merged.has(event.seq)) merged.set(event.seq, event)
    }
    const ordered = [...merged.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    if (lastEventId === undefined) {
      // 未声明水位：只收新事件，但先发一条当前水位，便于客户端之后续传。
      const head = ordered.length > 0 ? ordered[ordered.length - 1] : undefined
      return head === undefined ? [] : [{ type: 'myrix/subscribed', seq: head.seq, data: { sid }, time: head.time }]
    }
    const wanted = ordered.filter((event) => (event.seq ?? 0) > lastEventId)
    const oldest = ordered.length > 0 ? ordered[0]?.seq : undefined
    if (oldest !== undefined && oldest > lastEventId + 1) {
      // 缓冲已经丢掉客户端要的那一段：显式告知不连续，而不是假装连续。
      wanted.unshift({
        type: 'myrix/truncated',
        seq: oldest,
        data: { sid, from: lastEventId + 1, availableFrom: oldest },
        time: Date.now(),
      })
    }
    return wanted
  }

  private deliver(subscriber: Subscriber, event: StreamEvent): boolean {
    if (subscriber.closed) return false
    if (subscriber.replaying) {
      // 重放期间的实时事件先排队，等水位推进后再按 seq 去重。
      subscriber.pending.push(event)
      return true
    }
    const seq = event.seq
    if (typeof seq === 'number') {
      if (subscriber.watermark !== undefined && seq <= subscriber.watermark) return true
      subscriber.watermark = seq
    }
    if (!this.checkAdmission(subscriber)) return false
    return subscriber.sink.write(encodeSseFrame({ seq, type: event.type, data: event.data }))
  }

  private checkAdmission(subscriber: Subscriber): boolean {
    if (subscriber.closed) return false
    let admitted: boolean
    try {
      admitted = subscriber.admit()
    } catch {
      admitted = false
    }
    if (!admitted) {
      this.closeSubscriber(subscriber)
      return false
    }
    return true
  }

  private closeSubscriber(subscriber: Subscriber): void {
    if (subscriber.closed) return
    subscriber.closed = true
    this.subscribers.delete(subscriber)
    subscriber.sink.close()
  }
}
