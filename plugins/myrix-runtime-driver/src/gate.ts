/**
 * 准入闸门：进程级准入 + **每会话串行**。
 *
 * 两条独立的性质：
 *
 * 1. **进程级准入**：`drain()` 一旦开始就不再打开。排空是单向的 ——
 *    这个进程此后只服务在途命令，然后退出。缩零与唤醒的竞争由 Cell 管理器
 *    的状态机裁决（platform-plan-v2 §2.2），驱动的职责只是"关门后不再进人"。
 * 2. **每会话串行**：同一个 `sid` 上的命令按到达顺序逐个执行，避免
 *    "两条 create 同时跑"、"send 与 cancel 交错"这类竞态。不同会话之间并行。
 *
 * 这里刻意不实现超时/取消：命令的执行体自己带 signal，闸门只负责顺序与关门。
 *
 * @module @myrix/runtime-driver/gate
 */

/** 闸门拒绝的原因。 */
export type GateRejection = 'draining' | 'closed' | 'busy'

/** 闸门拒绝时抛出的错误；`reason` 可直接进 HTTP 响应。 */
export class GateClosedError extends Error {
  constructor(
    readonly kind: GateRejection,
    message: string,
  ) {
    super(message)
    this.name = 'GateClosedError'
  }
}

interface SessionQueue {
  /** 当前排队(含正在执行)的命令数；用于 inbox-empty 判定。 */
  pending: number
  /** 队尾 promise；保证同一会话严格串行。 */
  tail: Promise<unknown>
}

/**
 * 进程级准入 + 每会话串行的闸门。
 *
 * 状态机：`open` → `draining` → `closed`。
 * - `open`：接受新命令。
 * - `draining`：拒绝新命令；等在途命令与队列清空。
 * - `closed`：已确认空闲，不再接受任何命令（也不会回到 open）。
 */
export class AdmissionGate {
  private state: 'open' | 'draining' | 'closed' = 'open'
  private readonly queues = new Map<string, SessionQueue>()
  private inflight = 0
  private drained: Promise<void> | undefined
  private resolveDrained: (() => void) | undefined
  /** 当前活跃(尚未结算)的会话，供 drain 的空闲证明使用。 */
  private readonly active = new Set<string>()

  /** 进程是否仍在接受新命令。 */
  get accepting(): boolean {
    return this.state === 'open'
  }

  /** 是否已开始排空。 */
  get draining(): boolean {
    return this.state !== 'open'
  }

  /** 当前在途命令数（含排队）。 */
  get inflightCount(): number {
    return this.inflight
  }

  /** 当前活跃会话数；drain 成功后必须为 0。 */
  get activeSessions(): number {
    return this.active.size
  }

  /** 某会话是否还有排队或在途命令（inbox-empty 判定用）。 */
  hasPending(sid: string): boolean {
    const queue = this.queues.get(sid)
    return queue !== undefined && queue.pending > 0
  }

  /**
   * 在指定会话上串行执行一条命令。
   *
   * 排队发生在准入检查**之后**：一旦 drain 开始，新命令根本不会进队，
   * 因此 drain 等待的队列长度是单调下降的。
   *
   * @throws {GateClosedError} 当闸门已开始排空或已关闭。
   */
  run<T>(sid: string, operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      return Promise.reject(
        new GateClosedError(
          this.state === 'draining' ? 'draining' : 'closed',
          this.state === 'draining' ? 'cell 正在排空，拒绝新命令' : 'cell 已关闭，拒绝新命令',
        ),
      )
    }
    const queue = this.queues.get(sid) ?? { pending: 0, tail: Promise.resolve() }
    queue.pending += 1
    this.inflight += 1
    this.active.add(sid)
    this.queues.set(sid, queue)

    const result = queue.tail.then(operation, operation)
    // 队尾永远收敛成"已结算"：一条命令的失败不能卡住同一会话的后续命令。
    queue.tail = result.then(
      () => undefined,
      () => undefined,
    )
    const settle = (): void => {
      queue.pending -= 1
      this.inflight -= 1
      if (queue.pending === 0) {
        this.queues.delete(sid)
        this.active.delete(sid)
        this.maybeResolveDrained()
      }
    }
    return result.then(
      (value) => {
        settle()
        return value
      },
      (error: unknown) => {
        settle()
        throw error
      },
    )
  }

  /**
   * 关闭准入并等待空闲。
   *
   * 返回后保证：不再接受新命令、没有任何排队命令、没有活跃会话。
   * 重复调用返回同一个 promise（幂等）。
   */
  closeAndWait(): Promise<void> {
    if (this.state === 'open') this.state = 'draining'
    this.drained ??= new Promise<void>((resolve) => {
      this.resolveDrained = resolve
    })
    this.maybeResolveDrained()
    return this.drained
  }

  /** 排空完成后把状态锁死为 `closed`（不会回到 open）。 */
  seal(): void {
    this.state = 'closed'
  }

  private maybeResolveDrained(): void {
    if (this.state === 'open') return
    if (this.inflight > 0) return
    if (this.active.size > 0) return
    this.state = 'closed'
    const resolve = this.resolveDrained
    this.resolveDrained = undefined
    resolve?.()
  }
}
