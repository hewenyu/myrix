/**
 * `createSseWriter` 的单元测试（不依赖真实 HTTP）。
 *
 * 覆盖 issue 要求的五种情形：
 *   1. `write()===false` → 等 `'drain'` 后继续写（正常恢复，不丢帧、不中止上游）；
 *   2. `write()===false` 期间 `'close'`（消费者断线）→ 立即返回 aborted 并中止上游；
 *   3. 上游 signal 在等待期间 abort → 立即返回，不再写、不重复 abort；
 *   4. `write()` 抛错 → aborted(write_failed) 并中止上游；
 *   5. 停止之后**不再消费上游**（由调用方 break；这里断言 writer 不再接受写入）。
 *
 * 另加**背压 × gateway 内部超时/撤权**的回归：写出层必须监听 gateway 暴露的合并信号
 * （`upstreamSignal`），否则慢消费者只会被 server 侧的 client controller 唤醒 ——
 * gateway 自己建的 timeout/撤权 controller 只向内传播，等 drain 的写循环永远不醒，
 * iterator `finally` 不结算、响应不 `end()`。
 *
 * 另外断言"监听器不泄漏"：drain 监听器每次等待结束必摘，close/error/abort 常驻且
 * `dispose()` 后归零。
 */
import { describe, expect, it } from "vitest";
import { createSseWriter, type SseStopReason, type WritableLike } from "../src/stream";

const EVENT = "event: response.output_text.delta\ndata: {}\n\n";

/**
 * 可脚本化的可写替身：显式控制 `write()` 的返回值，并记录监听器数量。
 *
 * 监听器语义按 Node `EventEmitter` 建模（`once` 用 wrapper 自摘、`off` 幂等），
 * 否则"写入时摘监听器"会被误记成负数。
 */
class FakeWritable implements WritableLike {
  readonly chunks: string[] = [];
  /** 每个 chunk 的 write 返回值；用尽后默认 true。 */
  results: boolean[] = [];
  throwOnWrite: (() => boolean) | undefined;
  writableEnded = false;
  readonly counts = { drain: 0, close: 0, error: 0 };
  readonly #listenersMap: Record<"drain" | "close" | "error", Set<() => void>> = {
    drain: new Set(),
    close: new Set(),
    error: new Set(),
  };

  write(chunk: string): boolean {
    if (this.throwOnWrite?.()) throw new Error("write exploded");
    this.chunks.push(chunk);
    return this.results.shift() ?? true;
  }
  once(event: "drain" | "close" | "error", listener: () => void): this {
    const wrapper = (): void => {
      this.#remove(event, wrapper);
      listener();
    };
    // 与 Node 一致：wrapper 暴露原 listener，便于 off(event, original) 也能摘掉。
    Object.assign(wrapper, { listener });
    this.counts[event] += 1;
    this.#listenersMap[event].add(wrapper);
    return this;
  }
  off(event: "drain" | "close" | "error", listener: () => void): this {
    for (const entry of [...this.#listenersMap[event]]) {
      if (entry === listener || (entry as { listener?: () => void }).listener === listener) {
        this.#remove(event, entry);
      }
    }
    return this;
  }
  #remove(event: "drain" | "close" | "error", wrapper: () => void): void {
    if (this.#listenersMap[event].delete(wrapper)) this.counts[event] -= 1;
  }
  /** 触发事件；`once` 语义由 wrapper 自摘。 */
  emit(event: "drain" | "close" | "error"): void {
    for (const listener of [...this.#listenersMap[event]]) listener();
  }
}

/** 微任务冲刷：writer.write() 内部至少有一次 await。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(): { writable: FakeWritable; upstream: AbortController; writer: ReturnType<typeof createSseWriter> } {
  const writable = new FakeWritable();
  const upstream = new AbortController();
  const writer = createSseWriter({ writable, upstream });
  return { writable, upstream, writer };
}

describe("SSE writer 背压", () => {
  it("内部取消后只允许一个有界 error 通知，不转发迟到数据或等待 drain", async () => {
    const writable = new FakeWritable();
    const client = new AbortController();
    const internal = new AbortController();
    const writer = createSseWriter({ writable, upstream: client, upstreamSignal: internal.signal });
    internal.abort();
    writable.results = [false];
    const final = "event: error\ndata: {\"code\":\"upstream_timeout\"}\n\n";
    expect((await writer.write(EVENT)).status).toBe("aborted");
    expect((await writer.write(final)).status).toBe("aborted");
    await writer.write(final);
    expect(writable.chunks).toEqual([final]);
    expect(writable.counts.drain).toBe(0);
    expect(client.signal.aborted).toBe(false);
    writer.dispose();
  });

  it("write=false 时等待 drain 后继续写，不中止上游", async () => {
    const { writable, upstream, writer } = setup();
    writable.results = [false];

    const first = writer.write("a");
    await tick();
    // 仍在等 drain：没写完、上游没被中止。
    expect(writable.chunks).toEqual(["a"]);
    expect(upstream.signal.aborted).toBe(false);
    expect(writer.stopped).toBe(false);

    writable.emit("drain");
    await expect(first).resolves.toEqual({ status: "resumed" });
    expect(upstream.signal.aborted).toBe(false);

    // drain 之后可以继续写，且不再等待。
    await expect(writer.write("b")).resolves.toEqual({ status: "written" });
    expect(writable.chunks).toEqual(["a", "b"]);
    expect(writer.backpressured).toBe(true);
    writer.dispose();
  });

  it("等待 drain 期间 close（消费者断线）→ 立即 aborted 并中止上游", async () => {
    const { writable, upstream, writer } = setup();
    writable.results = [false];

    const pending = writer.write("a");
    await tick();
    expect(upstream.signal.aborted).toBe(false);

    writable.emit("close");
    await expect(pending).resolves.toEqual({ status: "aborted", reason: "client_closed" });
    expect(upstream.signal.aborted).toBe(true);
    expect(writer.stopped).toBe(true);

    // 停止后不再写任何东西（也不抛错）。
    await expect(writer.write("b")).resolves.toEqual({ status: "aborted", reason: "client_closed" });
    expect(writable.chunks).toEqual(["a"]);
    writer.dispose();
  });

  it("等待 drain 期间上游 signal abort → 立即返回，且不重复 abort", async () => {
    const { writable, upstream, writer } = setup();
    writable.results = [false];
    let aborts = 0;
    const original = upstream.abort.bind(upstream);
    upstream.abort = (reason?: unknown): void => {
      aborts += 1;
      original(reason);
    };

    const pending = writer.write("a");
    await tick();
    upstream.abort(new Error("myrix: gateway timeout"));
    await expect(pending).resolves.toEqual({ status: "aborted", reason: "upstream_aborted" });
    // 信号本来就是上游侧 abort 的，writer 不应再补一次。
    expect(aborts).toBe(1);
    expect(writer.stopped).toBe(true);
    writer.dispose();
  });

  it("等待 drain 期间 gateway 内部 timeout（合并信号）→ 唤醒等待并停止，只向内取消上游", async () => {
    const writable = new FakeWritable();
    // HTTP 边界的 client controller；gateway 内部 timeout 不会 abort 它。
    const client = new AbortController();
    // gateway 暴露给写出层的合并信号（client + 内部 timeout/撤权）。
    const internal = new AbortController();
    const merged = new AbortController();
    client.signal.addEventListener("abort", () => merged.abort(client.signal.reason), { once: true });
    internal.signal.addEventListener("abort", () => merged.abort(internal.signal.reason), { once: true });
    const writer = createSseWriter({ writable, upstream: client, upstreamSignal: merged.signal });
    writable.results = [false];

    const pending = writer.write("a");
    await tick();
    expect(writer.stopped).toBe(false);
    expect(client.signal.aborted).toBe(false);

    // gateway 内部超时：只 abort 自己那个 controller。
    internal.abort(new Error("myrix: gateway timeout"));

    await expect(pending).resolves.toEqual({ status: "aborted", reason: "upstream_aborted" });
    expect(writer.stopped).toBe(true);
    // client controller 不该被 writer 反向 abort（内部超时不是"客户端不可写"）。
    expect(client.signal.aborted).toBe(false);
    // 停止后不再消费上游。
    await expect(writer.write("b")).resolves.toEqual({ status: "aborted", reason: "upstream_aborted" });
    expect(writable.chunks).toEqual(["a"]);
    writer.dispose();
  });

  it("合并信号在创建前就已 abort（内部超时先于第一块）→ 不写、判 upstream_aborted", async () => {
    const writable = new FakeWritable();
    const client = new AbortController();
    const internal = new AbortController();
    internal.abort(new Error("myrix: authorization revoked"));
    const merged = new AbortController();
    merged.abort(internal.signal.reason);
    const writer = createSseWriter({ writable, upstream: client, upstreamSignal: merged.signal });

    await expect(writer.write("a")).resolves.toEqual({ status: "aborted", reason: "upstream_aborted" });
    expect(writable.chunks).toEqual([]);
    expect(client.signal.aborted).toBe(false);
    writer.dispose();
  });

  it("write 抛错 → aborted(write_failed) 并中止上游", async () => {
    const { writable, upstream, writer } = setup();
    writable.throwOnWrite = () => true;

    await expect(writer.write("a")).resolves.toEqual({ status: "aborted", reason: "write_failed" });
    expect(upstream.signal.aborted).toBe(true);
    expect(writer.stopped).toBe(true);
    writer.dispose();
  });

  it("已 abort 的信号在创建时就被认定为停止；后续 write 不再触发写入", async () => {
    const writable = new FakeWritable();
    const upstream = new AbortController();
    upstream.abort(new Error("myrix: authorization revoked"));
    const writer = createSseWriter({ writable, upstream });

    await expect(writer.write(EVENT)).resolves.toEqual({ status: "aborted", reason: "upstream_aborted" });
    expect(writable.chunks).toEqual([]);
    writer.dispose();
  });

  it("dispose 后不再保留 close/error/abort 监听器（无泄漏）", () => {
    const { writable, upstream, writer } = setup();
    expect(writable.counts.close).toBe(1);
    expect(writable.counts.error).toBe(1);
    expect(writable.counts.drain).toBe(0);

    writer.dispose();
    expect(writable.counts.close).toBe(0);
    expect(writable.counts.error).toBe(0);
    // dispose 之后触发 close/abort 不应再中止上游或抛错。
    writable.emit("close");
    expect(upstream.signal.aborted).toBe(false);
  });

  it("dispose 也从合并信号上摘掉监听（每连接恰好一挂一摘）", () => {
    const writable = new FakeWritable();
    const client = new AbortController();
    const merged = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const originalAdd = merged.signal.addEventListener.bind(merged.signal);
    const originalRemove = merged.signal.removeEventListener.bind(merged.signal);
    // 只记录类型；监听器本身仍按原语义注册/摘除。
    merged.signal.addEventListener = ((type: string, listener: EventListener, opts?: AddEventListenerOptions) => {
      added.push(type);
      originalAdd(type, listener, opts);
    }) as typeof merged.signal.addEventListener;
    merged.signal.removeEventListener = ((type: string, listener: EventListener, opts?: EventListenerOptions) => {
      removed.push(type);
      originalRemove(type, listener, opts);
    }) as typeof merged.signal.removeEventListener;

    const writer = createSseWriter({ writable, upstream: client, upstreamSignal: merged.signal });
    expect(added).toEqual(["abort"]);
    writer.dispose();
    expect(removed).toEqual(["abort"]);
    expect(writable.counts.close).toBe(0);
    expect(writable.counts.error).toBe(0);
  });

  it("每次背压等待都恰好多挂一个 drain 监听、结束即摘掉（不随写入次数累积）", async () => {
    const { writable, writer } = setup();
    writable.results = [false, false, false];
    for (const chunk of ["a", "b", "c"]) {
      const pending = writer.write(chunk);
      await tick();
      expect(writable.counts.drain).toBe(1);
      writable.emit("drain");
      await pending;
      expect(writable.counts.drain).toBe(0);
    }
    expect(writable.chunks).toEqual(["a", "b", "c"]);
    expect(writable.counts.close).toBe(1);
    expect(writable.counts.error).toBe(1);
    writer.dispose();
    expect(writable.counts.close).toBe(0);
    expect(writable.counts.error).toBe(0);
  });

  it("正常 end() 之后的 close 不算消费者中途断线（不中止上游、不改原因）", async () => {
    const { writable, upstream, writer } = setup();
    await expect(writer.write("a")).resolves.toEqual({ status: "written" });
    writable.writableEnded = true;
    writable.emit("close");
    expect(writer.stopped).toBe(false);
    expect(upstream.signal.aborted).toBe(false);
    writer.dispose();
  });

  it("stop 幂等：重复 stop 不重复中止上游", () => {
    const { upstream, writer } = setup();
    let aborts = 0;
    const original = upstream.abort.bind(upstream);
    upstream.abort = (reason?: unknown): void => {
      aborts += 1;
      original(reason);
    };
    const reasons: SseStopReason[] = ["client_closed", "write_failed", "upstream_aborted"];
    for (const reason of reasons) writer.stop(reason);
    expect(aborts).toBe(1);
    writer.dispose();
  });
});
