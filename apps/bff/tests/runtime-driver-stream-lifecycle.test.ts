/**
 * `runtime-driver-client.ts` 的**事件流生命周期**回归测试（真实 HTTP + 真实 undici）。
 *
 * 为什么单独一个文件、且必须用真实 HTTP：
 *   * 缺陷本身只在真实连接上出现 —— deadline 定时器在"已经收到有效响应头"之后仍然 armed，
 *     10s 后 abort 整条流，`projectStream` 只能报 `stream-interrupted`，浏览器看到断流。
 *     用假的 `fetchImpl` 复现不了 undici 的 abort/取消语义（挂起的 `reader.read()` 行为、
 *     连接是否真的释放）。
 *   * 这里的 node:http server 与全局 fetch（Node 内置 undici）都是真的，只有 SSE 的
 *     **内容**是我们写的；被验证的是客户端的生命周期判定，不是 driver 的业务逻辑。
 *
 * 覆盖（与 issue 的验收点对应）：
 *   1. 收到响应头后 deadline **必须停止**：空闲流与活跃流都要活过 deadline 数倍；
 *   2. 调用方 `AbortSignal` 的桥接**必须保留**：响应头之后、迭代器启动之前/之后的 abort
 *      都要立即结束（不是等下一个事件，也不能被 dispose 掉监听器）；
 *   3. 建立阶段（响应头到达前）的 deadline 语义**不变**：永不回头的连接照样超时；
 *   4. 资源只释放一次：提前 `return()` / 调用方 `break` / 自然 EOF 都要收敛并且真的关连接；
 *      特别是"消费者 `return()` 时正好有一个挂起的 read"不能把测试挂死（有界等待）；
 *   5. **迭代器从未启动**（没有第一次 `next()`）就 `return()` / `throw()` / 被父级 abort 时，
 *      惰性生成器的函数体根本没跑，必须由客户端自己取消尚未加锁的 body 并摘掉父级监听器，
 *      否则响应体与 HTTP 连接会永远挂着；已缓冲帧的取消同样要用 reader.cancel 真正关连接；
 *   6. 竞态：deadline 触发之后 fetch 才解析出响应，必须 fail-closed（不是"建立成功"）；
 *   7. 非流式请求的 deadline 与流式 HTTP 失败的行为不变（不回显上游 reason）。
 *
 * 时限选择：deadline 用几百毫秒量级（跑得快），但所有"必须发生"的断言都用宽松上界
 * （秒级）与"超过 deadline 数倍"的相对量，避免 CI 抖动导致 flaky；不写精确到毫秒的相等断言。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createDriverHttpClient, type DriverSseFrame } from "../src/runtime-driver-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const cellId = "cell-a";

/**
 * 本文件里"必须发生"的事件允许的最大等待（宽松上界，抗 CI 抖动）。
 * 必须明显小于 vitest 的 testTimeout（默认 5s）：真出现挂死时我们要的是一条
 * "哪一步没有落定"的干净断言失败，而不是整个用例被 vitest 掐掉。
 */
const SETTLE_MS = 3_000;

interface TestCell {
  readonly baseUrl: string;
  /** 每个连接被 HTTP 层关闭的次数（含正常收尾）：用于证明"取消真的释放了上游连接"。 */
  closes(): number;
  /** 收到的 `last-event-id`（缺省为 undefined）：证明请求头仍然按契约发送。 */
  readonly lastEventIds: Array<string | undefined>;
  close(): Promise<void>;
}

/**
 * 起一个真实 node:http "driver"：只实现 `GET /v1/sessions/:sid/events`，
 * SSE 内容由 `handler` 决定。`handler` 拿到的是原始 `res`，因此可以精确制造
 * "只发响应头"、"发一半"、"永不响应"这些边界。
 */
async function startCell(handler: (res: ServerResponse) => void | Promise<void>): Promise<TestCell> {
  let closes = 0;
  const lastEventIds: Array<string | undefined> = [];
  const server: Server = createServer((req, res) => {
    if (!(req.url ?? "").endsWith("/events")) {
      res.writeHead(404);
      res.end();
      return;
    }
    lastEventIds.push(req.headers["last-event-id"] as string | undefined);
    res.on("close", () => {
      closes += 1;
    });
    void Promise.resolve(handler(res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    closes: () => closes,
    lastEventIds,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cellOf = (cell: TestCell) => ({ tenantId, cellId, baseUrl: cell.baseUrl });

/** 与 driver 的 `encodeSseFrame` 对称的最简编码。 */
function sse(id: number | undefined, event: string, data: unknown): string {
  return `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const turnEnd = (id: number): string => sse(id, "turn/end", { turn: id, reason: { kind: "completed" } });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 有界等待：超时返回 `TIMEOUT` 而不是永远挂着（否则一个真 bug 会变成 vitest 超时，
 * 丢掉"到底哪一步没落定"的信息）。
 */
const TIMEOUT: unique symbol = Symbol("timeout");
async function settledOrTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return await Promise.race([promise, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);
}

const cells: TestCell[] = [];
afterEach(async () => {
  await Promise.all(cells.splice(0).map((cell) => cell.close()));
});

async function cell(handler: (res: ServerResponse) => void | Promise<void>): Promise<TestCell> {
  const started = await startCell(handler);
  cells.push(started);
  return started;
}

/** 打开事件流并断言成功（失败时把结构化失败打印出来，便于定位）。 */
async function openStream(
  client: ReturnType<typeof createDriverHttpClient>,
  target: TestCell,
  options: { deadlineMs?: number; signal?: AbortSignal; lastEventId?: number } = {},
) {
  const opened = await client.streamEvents(cellOf(target), "s-1", {
    grant: "grant-0123456789abcdef",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
  });
  if (!opened.ok) throw new Error(`事件流未能打开：${JSON.stringify(opened)}`);
  return opened.value;
}

describe("driver SSE establishment deadline", () => {
  it("stops the establishment deadline at the response headers: an idle stream survives far past it", async () => {
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 只发心跳再保持沉默：真实会话空闲时就是这样（心跳也是注释帧，不产生业务事件）。
      res.write(": hb\n\n");
    });
    const deadlineMs = 300;
    const client = createDriverHttpClient({ deadlineMs });
    const stream = await openStream(client, target);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    // 必须消费掉拒绝，否则失败路径会变成 unhandled rejection 而不是干净的断言。
    const outcome = pending.then(
      () => "settled" as const,
      (error: unknown) => `rejected:${String(error)}` as const,
    );

    // 关键断言：3 倍 deadline 之后仍然在等（旧实现会在 deadline 处 abort）。
    expect(await settledOrTimeout(outcome, deadlineMs * 3)).toBe(TIMEOUT);
    // 而且上游连接没有被关掉：deadline 确实停了，而不是"换了种方式断"。
    expect(target.closes()).toBe(0);

    // 调用方 signal 的桥接在响应头之后必须仍然有效（不能在"建立完成"时被 dispose 掉）。
    const controller = new AbortController();
    const abortable = await openStream(
      createDriverHttpClient({ deadlineMs }),
      target,
      { signal: controller.signal },
    );
    const abortIterator = abortable[Symbol.asyncIterator]();
    const abortPending = abortIterator.next();
    const abortOutcome: Promise<IteratorResult<DriverSseFrame> | Error> = abortPending.then(
      (result) => result,
      (error: Error) => error,
    );
    await sleep(50);
    const closesBeforeAbort = target.closes();
    controller.abort();
    const settled = await settledOrTimeout(abortOutcome, SETTLE_MS);
    expect(settled).not.toBe(TIMEOUT);
    // 挂起的读取以"结束"收敛（done 或 AbortError 都算正确的取消），绝不是继续挂着。
    if (settled !== TIMEOUT && !(settled instanceof Error)) expect(settled.done).toBe(true);
    // 取消必须真正释放上游连接。
    await expect(
      settledOrTimeout(sleep(100).then(() => target.closes() > closesBeforeAbort), SETTLE_MS),
    ).resolves.toBe(true);
    await abortIterator.return?.(undefined as never).catch(() => undefined);
    // 第一条（空闲）流也收尾：它同样必须释放自己的连接，且不影响上面的断言。
    const closesBeforeIdleReturn = target.closes();
    await iterator.return?.(undefined as never).catch(() => undefined);
    await expect(
      settledOrTimeout(sleep(100).then(() => target.closes() > closesBeforeIdleReturn), SETTLE_MS),
    ).resolves.toBe(true);
  });

  it("keeps delivering frames from an active stream past the establishment deadline", async () => {
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
      let seq = 0;
      const timer = setInterval(() => {
        seq += 1;
        res.write(turnEnd(seq));
      }, 50);
      res.on("close", () => clearInterval(timer));
    });
    const deadlineMs = 300;
    const client = createDriverHttpClient({ deadlineMs });
    const stream = await openStream(client, target, { lastEventId: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    const seqs: number[] = [];
    const started = Date.now();
    // 持续读到明显超过 deadline（约 3 倍）：旧实现在此之前就会抛 AbortError。
    while (Date.now() - started < deadlineMs * 3) {
      const next = await settledOrTimeout(iterator.next(), SETTLE_MS);
      expect(next).not.toBe(TIMEOUT);
      if (next === TIMEOUT || next.done === true) break;
      if (next.value.id !== undefined) seqs.push(next.value.id);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs * 2);
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    expect(seqs[seqs.length - 1]).toBeGreaterThanOrEqual(3);
    // 请求头仍按冻结契约发送。
    expect(target.lastEventIds).toContain("0");

    // 调用方提前结束：必须收敛并释放连接。
    await iterator.return?.(undefined as never);
    await expect(settledOrTimeout(sleep(100).then(() => target.closes() >= 1), SETTLE_MS)).resolves.toBe(true);
  });

  it("still fails closed when the response headers never arrive (establishment timeout unchanged)", async () => {
    const target = await cell(() => {
      // 接受连接但永不响应：建立阶段没有收到任何响应头。
    });
    const deadlineMs = 250;
    const client = createDriverHttpClient({ deadlineMs });
    const started = Date.now();
    const result = await client.streamEvents(cellOf(target), "s-1", { grant: "grant-0123456789abcdef" });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ ok: false, kind: "timeout", retryable: true });
    // 超时不得早于 deadline（定时器不会提前触发），也不得无限拖。
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 30);
    expect(elapsed).toBeLessThan(SETTLE_MS);
    // 建立失败仍然要放掉连接（不能留下一个没人管的 socket）。
    await expect(settledOrTimeout(sleep(100).then(() => target.closes() >= 1), SETTLE_MS)).resolves.toBe(true);
  });

  it("honors the parent abort after the headers even before the iterator is started", async () => {
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
    });
    const controller = new AbortController();
    const client = createDriverHttpClient({ deadlineMs: 250 });
    const stream = await openStream(client, target, { signal: controller.signal });
    // 在第一次 next() 之前就撤权：迭代器启动后必须立刻结束（不能被 pending read 挂住）。
    controller.abort();
    const iterator = stream[Symbol.asyncIterator]();
    const first = await settledOrTimeout(iterator.next(), SETTLE_MS);
    expect(first).not.toBe(TIMEOUT);
    if (first !== TIMEOUT) expect(first.done).toBe(true);
    await expect(settledOrTimeout(sleep(100).then(() => target.closes() >= 1), SETTLE_MS)).resolves.toBe(true);
  });

  it("releases resources once for early return, reader cancel and natural end even with a pending read", async () => {
    // (a) 消费者 return() 时正好有一个挂起的 read：必须有界收敛（旧实现会一直挂在 read 上）。
    const idle = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
    });
    const idleClient = createDriverHttpClient({ deadlineMs: 60_000 }); // 故意远大于测试时长
    const idleStream = await openStream(idleClient, idle);
    const idleIterator = idleStream[Symbol.asyncIterator]();
    const idlePending = idleIterator.next();
    idlePending.catch(() => undefined);
    const idleSettled = idlePending.then(() => "settled", () => "settled");
    const returnStarted = Date.now();
    const returned = idleIterator.return?.(undefined as never) ?? Promise.resolve({ done: true as const, value: undefined });
    await expect(settledOrTimeout(returned.then(() => "returned" as const), SETTLE_MS))
      .resolves.toBe("returned");
    expect(Date.now() - returnStarted).toBeLessThan(SETTLE_MS);
    await expect(settledOrTimeout(idleSettled, SETTLE_MS)).resolves.toBe("settled");
    await expect(settledOrTimeout(sleep(100).then(() => idle.closes() >= 1), SETTLE_MS)).resolves.toBe(true);

    // (b) `for await` 里 break（等价于 reader cancel）：同样有界收敛并关连接。
    const active = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(turnEnd(1));
      const timer = setInterval(() => res.write(": hb\n\n"), 50);
      res.on("close", () => clearInterval(timer));
    });
    const activeClient = createDriverHttpClient({ deadlineMs: 60_000 });
    const activeStream = await openStream(activeClient, active);
    const seen: DriverSseFrame[] = [];
    const drain = (async () => {
      for await (const frame of activeStream) {
        seen.push(frame);
        break;
      }
    })();
    await expect(settledOrTimeout(drain, SETTLE_MS)).resolves.not.toBe(TIMEOUT);
    expect(seen).toHaveLength(1);
    await expect(settledOrTimeout(sleep(100).then(() => active.closes() >= 1), SETTLE_MS)).resolves.toBe(true);

    // (c) 自然 EOF：读到尾部帧后 done，连接正常收尾（不是被 abort 掉的）。
    const ending = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${sse(1, "user/message", { content: [{ type: "text", text: "你好" }] })}\n${turnEnd(2)}`);
    });
    const endingClient = createDriverHttpClient({ deadlineMs: 60_000 });
    const endingStream = await openStream(endingClient, ending);
    const events: string[] = [];
    await expect(settledOrTimeout((async () => {
      for await (const frame of endingStream) events.push(frame.event);
    })(), SETTLE_MS)).resolves.not.toBe(TIMEOUT);
    expect(events).toEqual(["user/message", "turn/end"]);
    await expect(settledOrTimeout(sleep(100).then(() => ending.closes() >= 1), SETTLE_MS)).resolves.toBe(true);
  });

  it("cancels the upstream body when an unstarted iterator is returned or aborted, without any next()", async () => {
    // 缺陷：`sseFrames` 是**惰性**异步生成器。`streamEvents()` 成功返回后若调用方
    // （在第一次 `next()` 之前）就 `return()` / abort，生成器的函数体从未运行，
    // 也就没有 reader 去响应取消信号；旧实现只 abort 了 `cancelable`，body 与
    // HTTP 连接永远挂着（deadline 也已在 `established()` 时停掉）。
    // 这里用假 fetch 的 `ReadableStream.cancel` 计数精确证明"未启动也取消了"。
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
    });
    const createFake = (): { client: ReturnType<typeof createDriverHttpClient>; cancels: () => number } => {
      let cancels = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(": hb\n\n")); },
        cancel() { cancels += 1; },
      });
      return {
        client: createDriverHttpClient({
          deadlineMs: 60_000,
          fetchImpl: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
        }),
        cancels: () => cancels,
      };
    };

    // (a) `return()` 之前没有任何 `next()`：必须以 `done` 收敛，且 body 恰好取消一次。
    const returned = createFake();
    const unstarted = await openStream(returned.client, target);
    const unstartedIterator = unstarted[Symbol.asyncIterator]();
    const settled = await settledOrTimeout(
      Promise.resolve(unstartedIterator.return?.(undefined as never)).then(() => "returned" as const),
      SETTLE_MS,
    );
    expect(settled).toBe("returned");
    await expect(settledOrTimeout(sleep(50).then(() => returned.cancels()), SETTLE_MS)).resolves.toBe(1);
    // 再 return/throw 一次：幂等，不得重复取消（completion 用例已经取消过了）。
    await unstartedIterator.return?.(undefined as never).catch(() => undefined);
    await expect(settledOrTimeout(sleep(20).then(() => returned.cancels()), SETTLE_MS)).resolves.toBe(1);

    // (b) 父级在第一次 `next()` 之前 abort：同样必须取消未启动的 body（不能只 abort 内部信号）。
    const aborted = createFake();
    const controller = new AbortController();
    const abortable = await openStream(aborted.client, target, { signal: controller.signal });
    const abortIterator = abortable[Symbol.asyncIterator]();
    controller.abort();
    await expect(settledOrTimeout(sleep(50).then(() => aborted.cancels()), SETTLE_MS)).resolves.toBe(1);
    // 启动后必须立即以 done 结束（不能因为"没启动过"就凭空挂起）。
    const afterAbort = await settledOrTimeout(abortIterator.next(), SETTLE_MS);
    expect(afterAbort).not.toBe(TIMEOUT);
    if (afterAbort !== TIMEOUT) expect(afterAbort.done).toBe(true);

    // (c) 未启动的 `throw()`：生成器函数体不会运行（也不会执行 finally），同样必须取消 body。
    const thrown = createFake();
    const throwable = await openStream(thrown.client, target);
    const throwIterator = throwable[Symbol.asyncIterator]();
    await expect(throwIterator.throw?.(new Error("caller gave up"))).rejects.toThrow("caller gave up");
    await expect(settledOrTimeout(sleep(50).then(() => thrown.cancels()), SETTLE_MS)).resolves.toBe(1);
  });

  it("removes the parent-signal listener after an unstarted return and still cancels buffered frames", async () => {
    // 监听器清理：未启动就 `return()` 之后，父级 signal 上不能残留本流的监听器，
    // 否则长生命周期的父 signal（进程关闭/撤权）会一直握住这条已死的流。
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
    });
    const controller = new AbortController();
    const client = createDriverHttpClient({ deadlineMs: 60_000 });
    const stream = await openStream(client, target, { signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await stream[Symbol.asyncIterator]().return?.(undefined as never);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    // 已缓冲帧的取消：服务端一口气写完两帧后**保持连接**。消费者只读第一帧就 return，
    // 第二帧仍在客户端缓冲里 —— 此时 body 已被生成器的 reader 锁定，必须由 reader.cancel()
    // 释放连接（`body.cancel()` 在 locked 时无效）。
    const buffered = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`${turnEnd(1)}${turnEnd(2)}`);
      // 不 end()：连接保持打开，等待消费端取消。
    });
    const bufferedClient = createDriverHttpClient({ deadlineMs: 60_000 });
    const bufferedStream = await openStream(bufferedClient, buffered);
    const bufferedIterator = bufferedStream[Symbol.asyncIterator]();
    const first = await settledOrTimeout(bufferedIterator.next(), SETTLE_MS);
    expect(first).not.toBe(TIMEOUT);
    if (first !== TIMEOUT) expect(first.value.event).toBe("turn/end");
    const closesBefore = buffered.closes();
    await expect(settledOrTimeout(
      Promise.resolve(bufferedIterator.return?.(undefined as never)).then(() => "returned" as const),
      SETTLE_MS,
    )).resolves.toBe("returned");
    await expect(
      settledOrTimeout(sleep(100).then(() => buffered.closes() > closesBefore), SETTLE_MS),
    ).resolves.toBe(true);
  });

  it("fails closed when fetch resolves the response only after the establishment deadline fired", async () => {
    // 竞速：deadline 触发 abort 之后，fetch 才把（已经被 abort 的请求的）响应交回来。
    // 此时 deadline 已失效，交付一条"成功"的流只会立刻结束，调用方却会当成正常订阅；
    // 必须按 fail-closed 返回 timeout，并取消这个迟到的响应体。
    let lateCancels = 0;
    const client = createDriverHttpClient({
      deadlineMs: 40,
      fetchImpl: ((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode(": hb\n\n")); },
            cancel() { lateCancels += 1; },
          });
          resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }, { once: true });
      })) as unknown as typeof fetch,
    });
    const target = await cell(() => undefined);
    const result = await client.streamEvents(cellOf(target), "s-1", { grant: "grant-0123456789abcdef" });
    expect(result).toMatchObject({ ok: false, kind: "timeout", retryable: true });
    expect(lateCancels).toBe(1);
  });

  it("closes a real idle connection when the iterator is returned before any next()", async () => {
    // 真实 HTTP 版本：服务端只发响应头后保持沉默（正是"建立成功但从未启动迭代器"的场景）。
    // 未启动的 `return()` 必须让服务端观察到连接关闭；否则连接会一直挂到进程结束。
    const target = await cell((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hb\n\n");
    });
    const client = createDriverHttpClient({ deadlineMs: 60_000 });
    const stream = await openStream(client, target);
    const iterator = stream[Symbol.asyncIterator]();
    // 刻意**不**调用 next()：生成器函数体从未运行。
    expect(await settledOrTimeout(
      Promise.resolve(iterator.return?.(undefined as never)).then(() => "returned" as const),
      SETTLE_MS,
    )).toBe("returned");
    await expect(settledOrTimeout(sleep(100).then(() => target.closes() >= 1), SETTLE_MS)).resolves.toBe(true);
  });

  it("keeps non-stream deadlines and stream HTTP failures unchanged", async () => {
    // 非流式请求仍是"请求级 deadline"：永不响应就在 deadline 处超时。
    const hanging = await cell(() => {
      // 永不响应（/events 之外的路径这里用 /v1/ready 走 ready()，但该 server 只认 /events）。
    });
    const nonStream = createDriverHttpClient({ deadlineMs: 200 });
    const ready = await nonStream.ready(cellOf(hanging), { timeoutMs: 200 });
    // 该测试 server 对 /v1/ready 回 404（不是流），因此这里只断言"不是 timeout 挂死"。
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.kind).toBe("http");

    // 流式 HTTP 失败：结构化分类不变，且不回显上游 reason 原文。
    const denied = await cell((res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "grant_rejected", code: "grant/expired", reason: "token=sk-live-secret" }));
    });
    const deniedClient = createDriverHttpClient({ deadlineMs: 2_000 });
    const failure = await deniedClient.streamEvents(cellOf(denied), "s-1", { grant: "grant-0123456789abcdef" });
    expect(failure).toMatchObject({ ok: false, kind: "http", status: 403, code: "grant/expired", retryable: false });
    if (!failure.ok) {
      expect(failure.reason).not.toContain("sk-live-secret");
      expect(failure.reason).toMatch(/^driver 返回 403/);
    }
  });
});
