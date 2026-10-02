/**
 * SSE 写出端：把 gateway 的 `AsyncIterable<string>` 逐块写进 HTTP 响应，**尊重背压**。
 *
 * 背景：旧实现 `for await (const chunk of stream) raw.write(chunk)` 忽略 `write()` 的
 * 返回值 —— 一个不读响应的客户端能让 Node 写缓冲无限增长（每连接吃光进程内存），
 * 网关还在全速消费上游烧额度，而 `gateway.ts` 的 `finally` 结算永不执行。
 *
 * 契约：
 * * `write() === false` → 等 `'drain'`（恢复）或 `'close'`/`'error'`/**上游信号 abort**
 *   （停止）；等待中的临时 `'drain'` 监听器一定被摘掉；
 * * **上游信号必须从这里传入**：gateway 内部的 timeout/撤权 controller 与客户端断线
 *   合并成同一个 `AbortSignal`（`GatewayResponse` 的 `signal`），否则背压等待只认
 *   server 侧的 client controller，gateway 内部超时无法唤醒等待 → 迭代器 `finally`
 *   不结算、响应不 `end()`，永久挂死；
 * * 非 `written`/`resumed` 的写出结果都意味着"不要再消费上游"——调用方据此 break，
 *   让 `gateway.ts` 的 `finally` 走原有结算语义（断流 → 保守保留预占）；
 * * `stop()` 幂等：只有消费者已不可能再读（`client_closed`/`write_failed`）时才主动
 *   `upstream.abort()`；`upstream_aborted` 表示信号本就被上游侧触发，不重复 abort；
 * * `dispose()` 摘掉全部监听器，每个连接恰好挂一次、收尾摘一次，不随连接数泄漏。
 *
 * 已写入字节后不可能再改状态码，因此只区分"正常收尾（`end()`）"与"连接已不可写"。
 */

/** 停止原因；调用方据此解释"为什么不再转发"，不改变 gateway 自身的结算判定。 */
export type SseStopReason = "client_closed" | "write_failed" | "upstream_aborted";

/** 单次写出结果。只有 `written` / `resumed` 代表可以安全地继续消费下一个上游分片。 */
export type SseWriteResult =
  | { status: "written" }
  /** 曾返回 false，但 drain 已到，内核缓冲降回水位以下。 */
  | { status: "resumed" }
  | { status: "aborted"; reason: SseStopReason };

/**
 * 需要观察与控制的上游（HTTP 边界的 client controller）：`.signal` 用于"上游侧已经
 * 放弃"，`.abort()` 用于"消费者已经走了，我们主动放弃上游"。
 * 不直接收 `AbortSignal`，因为 `signal.dispatchEvent()` **不会**把 `signal.aborted`
 * 置真，而 gateway 的结算判定全部读 `signal.aborted`。
 */
export interface UpstreamAborter {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

/**
 * 最小可写面。`ServerResponse` 天然满足；测试可给一个只记录调用的替身。
 * 故意不要求 `NodeJS.WritableStream`，把"`write` 必须返回 boolean"写成显式契约。
 */
export interface WritableLike {
  write(chunk: string): boolean;
  readonly writableEnded?: boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}

export interface SseWriterOptions {
  writable: WritableLike;
  /** HTTP 边界的客户端取消控制器；慢消费者/写失败时由 `stop()` 调用 `abort()`。 */
  upstream: UpstreamAborter;
  /**
   * gateway 暴露的合并信号（客户端断线 / 撤权 / 上游超时）。背压等待必须同时监听它，
   * 否则内部 timeout/撤权只能取消上游连接，却唤不醒等 drain 的写循环。
   */
  upstreamSignal?: AbortSignal;
}

export interface SseWriter {
  /** 写一块。永不抛错：写失败折叠成 `aborted`。 */
  write(chunk: string): Promise<SseWriteResult>;
  /** 停止转发；幂等。不 `end()` 响应（收尾由调用方决定）。 */
  stop(reason: SseStopReason): void;
  /** 是否已停止（主动 stop、close、error、合并信号 abort 都算）。 */
  readonly stopped: boolean;
  /** 连接上是否出现过 `write() === false`（诊断/测试可断言）。 */
  readonly backpressured: boolean;
  /** 摘掉全部监听器；幂等。 */
  dispose(): void;
}

/**
 * 创建一个遵守背压的 SSE writer。
 *
 * 监听策略：`'drain'` 每次进入背压时临时挂、等待结束必摘；`'close'`/`'error'` 与合并
 * 信号 `abort` 是常驻，直到 `dispose()` 摘掉 —— 因此"写得越多监听器越多"不会发生。
 */
export function createSseWriter(options: SseWriterOptions): SseWriter {
  const { writable, upstream } = options;
  // 没有单独给合并信号时退回 upstream.signal：调用方至少还能观察到边界信号。
  const upstreamSignal = options.upstreamSignal ?? upstream.signal;

  let stopped = false;
  let stopReason: SseStopReason | undefined;
  let backpressured = false;
  let terminalWritten = false;
  /** 唤醒当前 drain 等待者；每次等待结束都会清空。 */
  let wakeWait: (() => void) | undefined;

  function stop(reason: SseStopReason): void {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    // 消费者已经不可能再读时才主动中止上游：继续拉上游 = 白烧额度。
    // `upstream_aborted` 表示 abort 本就从上游侧发出（超时/撤权/请求中止），不重复调用。
    if (reason !== "upstream_aborted") {
      try {
        upstream.abort(new Error(`myrix: sse ${reason}`));
      } catch {
        // 中止失败不能反过来把写循环挂死；循环本身仍会因为 stopped 停下。
      }
    }
    wakeWait?.();
  }

  const onClose = (): void => {
    terminalWritten = true;
    // 正常 `end()` 之后也会收到 'close'；那不是"消费者中途走了"，不能中止上游
    // （此时 gateway 早已按真实 usage 结算完毕）。
    if (writable.writableEnded !== true) stop("client_closed");
  };
  const onError = (): void => {
    terminalWritten = true;
    stop("write_failed");
  };
  const onAbort = (): void => stop("upstream_aborted");

  writable.once("close", onClose);
  writable.once("error", onError);
  upstreamSignal.addEventListener("abort", onAbort, { once: true });
  // 信号可能在交给 writer 之前就已经 abort（例如上游超时先于第一块写出）。
  if (upstreamSignal.aborted) stop("upstream_aborted");

  /** 等 drain / close / error / 合并信号 abort 之一；返回前保证摘掉临时监听器。 */
  const waitForWritable = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        writable.off("drain", onDrain);
        if (wakeWait === finish) wakeWait = undefined;
        resolve();
      };
      const onDrain = (): void => finish();
      wakeWait = finish;
      writable.once("drain", onDrain);
    });

  return {
    get stopped(): boolean {
      return stopped;
    },
    get backpressured(): boolean {
      return backpressured;
    },
    async write(chunk: string): Promise<SseWriteResult> {
      if (stopped) {
        // 内部 abort 先于 generator yield 固定 error 帧。正常可写的客户端仍应收到
        // 可读失败原因；只允许一次、有界、非等待的终态写，绝不恢复普通数据流。
        // 背压/客户端断线时不尝试补帧，避免再次挂在 drain 上。
        if (stopReason === "upstream_aborted" && !upstream.signal.aborted &&
            !backpressured && !terminalWritten && writable.writableEnded !== true &&
            chunk.length <= 8192 && chunk.startsWith("event: error\n")) {
          terminalWritten = true;
          try { writable.write(chunk); } catch { /* 终态通知是 best-effort，结算仍由 generator finally 完成。 */ }
        }
        return { status: "aborted", reason: stopReason ?? "client_closed" };
      }
      if (writable.writableEnded === true) {
        stop("client_closed");
        return { status: "aborted", reason: "client_closed" };
      }
      let ok: boolean;
      try {
        ok = writable.write(chunk);
      } catch {
        stop("write_failed");
        return { status: "aborted", reason: "write_failed" };
      }
      if (ok) return { status: "written" };
      backpressured = true;
      await waitForWritable();
      return stopped ? { status: "aborted", reason: stopReason ?? "client_closed" } : { status: "resumed" };
    },
    stop,
    dispose(): void {
      stopped = true;
      terminalWritten = true;
      writable.off("close", onClose);
      writable.off("error", onError);
      upstreamSignal.removeEventListener("abort", onAbort);
      wakeWait?.();
    },
  };
}
