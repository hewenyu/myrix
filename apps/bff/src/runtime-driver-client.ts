/**
 * Driver HTTP 客户端（BFF 侧）。
 *
 * 只实现路由/投递循环需要的四个端点，并且**绝不模拟成功**：
 * 连接失败、超时、非 2xx、正文不合契约，全部返回结构化的失败结果，
 * 由调用方决定"保持队列并退避重试"还是"明确失败"。
 *
 * 契约（docs/implementation/runtime-driver.md §3）：
 *   POST /v1/commands              Bearer <grant>，正文是**签过名的那些字节**
 *   GET  /v1/commands/:commandId   Bearer <grant>；404 = 没有回执
 *   GET  /v1/sessions/:sid/events  Bearer <grant op=subscribe>，SSE
 *   POST /v1/admin/revoke          service credential（控制面签名/凭据）
 *   GET  /v1/ready                 就绪 + bootId
 *
 * 安全要点：
 *   * 请求体一律用调用方给的 `Buffer` 原样发送：任何"重新 JSON.stringify"都会让
 *     凭证里的 `bh` 与实际字节不再一致，driver 侧必然拒绝（这是刻意的绑定）。
 *   * 只发送我们自己构造的头；不转发任何浏览器请求头（尤其 cookie / Authorization）。
 *   * 上游响应体有硬上限；LLM 事件流按帧有界解析，超限即断开而不是把内存打满。
 *     任何提前结束的读取都必须 `cancel()` response.body reader（而不是只 releaseLock）：
 *     否则连接不会被释放，上游还会继续往一个没人读的流里写。
 *   * 外部错误 reason **固定文案**：不回显 token、正文、上游原始异常 message/name 或
 *     driver 的 `reason` 文本（它可能带 prompt/header/内部细节）。机器可读的 `code`
 *     与状态码保留，重试分类不变。
 */
import type { RuntimeLogger } from "./runtime-log";
import type { CellEndpoint } from "./runtime-cells";

/** driver 返回的命令回执。 */
export interface DriverCommandReceipt {
  status: "accepted" | "duplicate";
  commandId: string;
  bootId: string;
  note?: string;
}

/** `GET /v1/ready` 的响应。 */
export interface DriverReadyResponse {
  ready: boolean;
  bootId: string;
  draining: boolean;
  reason?: string;
}

/** `POST /v1/admin/revoke` 的响应。 */
export interface DriverRevokeResponse {
  accepted: boolean;
  sid: string;
  rev: number;
  reason: string;
  disposed?: boolean;
  closedStreams?: number;
}

/** 一帧已经解析过的 SSE 事件；`data` 已 JSON 解析（失败时为 undefined 并带 parseError）。 */
export interface DriverSseFrame {
  /** 持久事件的 seq；瞬态帧与部分控制帧可能没有。 */
  id?: number;
  /** `event:` 字段；缺省按 SSE 规范等价于 `message`。 */
  event: string;
  data: unknown;
  /** data 不是合法 JSON（或非 UTF-8）时为 true；调用方不应把它当业务事件处理。 */
  parseError?: boolean;
}

export type DriverFailureKind = "unreachable" | "timeout" | "aborted" | "http" | "malformed";

export interface DriverFailure {
  ok: false;
  kind: DriverFailureKind;
  /** 可读且不含敏感信息的原因，可直接进审计/日志与（部分）HTTP 响应。 */
  reason: string;
  /** HTTP 状态码（仅 kind=http）。 */
  status?: number;
  /** driver 的机器可读错误码（仅 kind=http，形如 `grant/expired`）。 */
  code?: string;
  /** 该失败是否值得原样重试（超时/unreachable 值得；4xx 契约错误不值得）。 */
  retryable: boolean;
}

export type DriverResult<T> = { ok: true; value: T } | DriverFailure;

export interface DriverRequestOptions {
  /** 调用方取消信号（撤权 / 进程关闭 / 浏览器断开）。 */
  signal?: AbortSignal;
  /** 本次请求的截止时间（毫秒）；缺省用客户端级 deadlineMs。 */
  timeoutMs?: number;
}

export interface DriverHttpClient {
  readonly name: string;
  ready(cell: CellEndpoint, options?: DriverRequestOptions): Promise<DriverResult<DriverReadyResponse>>;
  /** 投递命令；`rawBody` 必须与签发凭证时签的字节是同一个 Buffer。 */
  postCommand(
    cell: CellEndpoint,
    rawBody: Buffer,
    grant: string,
    options?: DriverRequestOptions,
  ): Promise<DriverResult<DriverCommandReceipt>>;
  getReceipt(
    cell: CellEndpoint,
    commandId: string,
    grant: string,
    options?: DriverRequestOptions,
  ): Promise<DriverResult<DriverCommandReceipt | undefined>>;
  /** 打开事件流；成功时返回一个**有界**的帧异步迭代器（读完必须释放）。 */
  streamEvents(
    cell: CellEndpoint,
    sessionId: string,
    options: DriverRequestOptions & { grant: string; lastEventId?: number },
  ): Promise<DriverResult<AsyncIterable<DriverSseFrame>>>;
  revoke(
    cell: CellEndpoint,
    notice: { sid: string; rev: number; reason: string },
    options?: DriverRequestOptions,
  ): Promise<DriverResult<DriverRevokeResponse>>;
}

export interface DriverHttpClientOptions {
  /** 测试可注入；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求的默认截止时间（毫秒）。 */
  deadlineMs?: number;
  /** 非流式响应体的字节上限。 */
  maxResponseBytes?: number;
  /** SSE 单帧字节上限。 */
  maxFrameBytes?: number;
  logger?: RuntimeLogger;
}

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

class AbortError extends Error {
  constructor(readonly kind: "timeout" | "aborted") {
    super(kind);
    this.name = "AbortError";
  }
}

/** 取消一个响应体（超限/提前退出时用）；释放连接而不是把上游挂着继续写。 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已经关闭/已出错：忽略。
  }
}

/** 非流式读取的上限保护：先看 content-length，再按字节累计；超限即取消响应体。 */
async function readBoundedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    // 声明就已经超限：一个字节都不读，直接把响应体取消掉。
    await cancelBody(response);
    return undefined;
  }
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  /** 正常读到 EOF 才为 true；否则（超限或读取抛错）都要 cancel 上游。 */
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        overflow = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      // 不能再读了（超限或读取抛错）：显式 cancel（不只是 releaseLock），否则上游连接会一直挂着。
      try {
        await reader.cancel();
      } catch {
        // reader 已释放或流已出错；忽略。
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // reader 已释放；忽略。
    }
  }
  if (overflow) return undefined;
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    return undefined;
  }
}

function failure(kind: DriverFailureKind, reason: string, extra: Partial<DriverFailure> = {}): DriverFailure {
  const retryable = extra.retryable ?? (kind === "unreachable" || kind === "timeout");
  return { ok: false, kind, reason, retryable, ...extra };
}

/** 连接类失败的**固定**外部文案：不带上游异常类型/消息（它们可能含地址、token 或内部细节）。 */
function unreachableFailure(): DriverFailure {
  return failure("unreachable", "无法连接 driver（网络错误或连接被拒）");
}

/** driver 错误码的安全形态：只保留短标识符字符；不合法就丢弃（错误码本身也可能被污染）。 */
function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, 64);
  return /^[A-Za-z0-9._:/-]{1,64}$/.test(bounded) ? bounded : undefined;
}

/**
 * 把 driver 的错误响应翻译成结构化失败。
 *
 * **只取机器可读的 `code`**：`reason` 是上游文本，可能含 prompt / header / 工具 schema /
 * 内部异常细节，一律**不透传**。外部 reason 用本模块自己的固定分类文案，
 * 重试判定（5xx / 429 可重试，其余 4xx 不可）保持不变。
 */
function httpFailure(status: number, payload: unknown): DriverFailure {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const code = safeCode(record["code"]) ?? safeCode(record["error"]);
  const category = status === 401 || status === 403
    ? "凭证或权限被拒"
    : status === 404
      ? "目标不存在"
      : status === 409
        ? "与既有命令冲突"
        : status === 429
          ? "上游限流"
          : status >= 500
            ? "cell 内部错误"
            : "请求不符合契约";
  // 401/403 是凭证问题，重试同样的凭证没有意义；5xx 与 429 可以退避重试。
  const retryable = status >= 500 || status === 429;
  return failure("http", `driver 返回 ${String(status)}（${category}）`, {
    status,
    ...(code === undefined ? {} : { code }),
    retryable,
  });
}

export function createDriverHttpClient(options: DriverHttpClientOptions = {}): DriverHttpClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("myrix-bff runtime: 运行环境缺少 fetch，无法创建 driver 客户端");
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("myrix-bff runtime: deadlineMs 必须是正整数");
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  /**
   * 建立"调用方 signal + 截止时间"合并后的信号。
   *
   * * `established()`：**只**停掉截止时间定时器（响应头已经到达 = 建立阶段结束），
   *   但**保留**调用方 signal 的桥接 —— 流可能在响应头之后还要存活任意长时间，
   *   撤权 / 浏览器断开 / 进程关闭必须能继续中止它。
   * * `dispose()`：流真正结束（自然收尾 / 取消 / 出错）后一次性清理：停定时器 +
   *   移除调用方 signal 监听；幂等。
   * * 先到先得：`aborted` 与 `timeout` 谁先触发就登记谁，之后不再被后者覆盖，
   *   分类因此是确定的（fail-closed）。
   */
  function withDeadline(request: DriverRequestOptions): {
    signal: AbortSignal;
    /** 建立阶段（收到有效响应头）结束：停掉截止定时器，保留调用方 signal 桥接。 */
    established: () => void;
    dispose: () => void;
    fired: () => "timeout" | "aborted" | undefined;
  } {
    const controller = new AbortController();
    let fired: "timeout" | "aborted" | undefined;
    let disposed = false;
    const onAbort = (): void => {
      if (fired === undefined) fired = "aborted";
      controller.abort(new AbortError("aborted"));
    };
    if (request.signal) {
      if (request.signal.aborted) {
        fired = "aborted";
        controller.abort(new AbortError("aborted"));
      } else {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      if (fired === undefined) fired = "timeout";
      controller.abort(new AbortError("timeout"));
    }, request.timeoutMs ?? deadlineMs);
    timer.unref?.();
    const clearTimer = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    return {
      signal: controller.signal,
      fired: () => fired,
      established: clearTimer,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearTimer();
        request.signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  function abortOutcome(handle: { fired: () => "timeout" | "aborted" | undefined }): DriverFailure {
    return handle.fired() === "aborted"
      ? failure("aborted", "请求已被调用方取消", { retryable: false })
      : failure("timeout", "driver 请求超时，结果未知（必须先查回执再决定是否重发）");
  }

  async function jsonRequest<T>(
    cell: CellEndpoint,
    path: string,
    init: { method: string; headers: Record<string, string>; body?: Buffer },
    request: DriverRequestOptions,
    accept: (value: unknown) => T | undefined,
  ): Promise<DriverResult<T | undefined>> {
    const handle = withDeadline(request);
    try {
      const response = await fetchImpl(cell.baseUrl + path, {
        method: init.method,
        headers: { accept: "application/json", ...init.headers },
        ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
        signal: handle.signal,
      });
      const text = await readBoundedText(response, maxResponseBytes);
      if (text === undefined) return failure("malformed", "driver 响应体超过上限或不是合法 UTF-8", { retryable: false });
      let payload: unknown;
      try {
        payload = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        return failure("malformed", "driver 响应不是合法 JSON", { retryable: false });
      }
      if (!response.ok) return httpFailure(response.status, payload);
      const value = accept(payload);
      if (value === undefined) return failure("malformed", "driver 响应缺少必需字段", { retryable: false });
      return { ok: true, value };
    } catch (error) {
      if (handle.fired() !== undefined) return abortOutcome(handle);
      if (error instanceof Error && error.name === "AbortError") return failure("aborted", "请求已被取消", { retryable: false });
      return unreachableFailure();
    } finally {
      handle.dispose();
    }
  }

  function receiptOf(value: unknown): DriverCommandReceipt | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const status = record["status"];
    const commandId = record["commandId"];
    const bootId = record["bootId"];
    if (status !== "accepted" && status !== "duplicate") return undefined;
    if (typeof commandId !== "string" || typeof bootId !== "string" || commandId.length === 0 || bootId.length === 0) return undefined;
    const note = record["note"];
    return { status, commandId, bootId, ...(typeof note === "string" ? { note } : {}) };
  }

  return {
    name: "createDriverHttpClient",

    async ready(cell, request = {}) {
      const result = await jsonRequest(
        cell,
        "/v1/ready",
        { method: "GET", headers: {} },
        request,
        (value): DriverReadyResponse | undefined => {
          if (value === null || typeof value !== "object") return undefined;
          const record = value as Record<string, unknown>;
          const bootId = record["bootId"];
          if (typeof bootId !== "string" || bootId.length === 0) return undefined;
          const ready = record["ready"];
          const draining = record["draining"];
          if (typeof ready !== "boolean" || typeof draining !== "boolean") return undefined;
          const reason = record["reason"];
          // driver 自述的就绪原因：去掉控制字符并截断，避免上游文本被原样带进日志/响应。
          // oxlint-disable-next-line no-control-regex -- 这里的匹配对象就是控制字符本身：这是安全过滤，不是笔误。
          const safeReason = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : undefined;
          return { ready, bootId, draining, ...(safeReason === undefined || safeReason.length === 0 ? {} : { reason: safeReason }) };
        },
      );
      return result.ok ? { ok: true, value: result.value as DriverReadyResponse } : result;
    },

    async postCommand(cell, rawBody, grant, request = {}) {
      const result = await jsonRequest(
        cell,
        "/v1/commands",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${grant}` },
          body: rawBody,
        },
        request,
        receiptOf,
      );
      return result.ok ? { ok: true, value: result.value as DriverCommandReceipt } : result;
    },

    async getReceipt(cell, commandId, grant, request = {}) {
      const handle = withDeadline(request);
      try {
        const response = await fetchImpl(`${cell.baseUrl}/v1/commands/${encodeURIComponent(commandId)}`, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${grant}` },
          signal: handle.signal,
        });
        if (response.status === 404) {
          // 明确"没有回执"：不是失败，调用方据此决定是否重发。
          await response.body?.cancel().catch(() => undefined);
          return { ok: true, value: undefined };
        }
        const text = await readBoundedText(response, maxResponseBytes);
        if (text === undefined) return failure("malformed", "driver 响应体超过上限或不是合法 UTF-8", { retryable: false });
        let payload: unknown;
        try {
          payload = text.length === 0 ? undefined : JSON.parse(text);
        } catch {
          return failure("malformed", "driver 响应不是合法 JSON", { retryable: false });
        }
        if (!response.ok) return httpFailure(response.status, payload);
        const receipt = receiptOf(payload);
        if (receipt === undefined) return failure("malformed", "driver 回执缺少必需字段", { retryable: false });
        return { ok: true, value: receipt };
      } catch (error) {
        if (handle.fired() !== undefined) return abortOutcome(handle);
        if (error instanceof Error && error.name === "AbortError") return failure("aborted", "请求已被取消", { retryable: false });
        return unreachableFailure();
      } finally {
        handle.dispose();
      }
    },

    async streamEvents(cell, sessionId, request) {
      const handle = withDeadline(request);
      try {
        const response = await fetchImpl(`${cell.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${request.grant}`,
            ...(request.lastEventId === undefined ? {} : { "last-event-id": String(request.lastEventId) }),
          },
          signal: handle.signal,
        });
        if (!response.ok) {
          const text = await readBoundedText(response, maxResponseBytes);
          let payload: unknown;
          try {
            payload = text === undefined || text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            payload = undefined;
          }
          handle.dispose();
          return httpFailure(response.status, payload);
        }
        // fetch 可能在其内部已被 abort 之后才解析出这个响应（建立截止时间或父级 signal
        // 与响应解析竞速）。此时绝不能把它当成"建立成功"返回：deadline 已经失效，
        // 交付出去的流只会立刻结束，调用方却会把它当成一条正常的流（fail-closed）。
        if (handle.fired() !== undefined) {
          await cancelBody(response);
          handle.dispose();
          return abortOutcome(handle);
        }
        if (!response.body) {
          handle.dispose();
          return failure("malformed", "driver 事件流没有响应体", { retryable: false });
        }
        // 截止时间只覆盖"建立连接 + 收到有效响应头"：一旦拿到**有效**响应头就停掉定时器，
        // 会话空闲多久都不会因为建立阶段的 deadline 被掐断（这是之前的真实缺陷：
        // 定时器在响应头之后仍然armed，10s 后 abort，projectStream 只能报 stream-interrupted）。
        // 调用方 signal 的桥接**必须保留**：撤权 / 浏览器断开 / 进程关闭要能中止整条流。
        handle.established();
        const body = response.body;
        const cancelable = new AbortController();
        // 把"取消"信号交给 sseFrames：读循环常常正阻塞在 `reader.read()` 上（会话空闲），
        // 生成器自身的 finally 要等这次读收敛才会执行。只有持有锁的 reader 自己
        // `cancel()` 才能让挂起的读取立刻结束（此时 `body.cancel()` 会因 locked 而失败），
        // 因此由 sseFrames 在收到该信号时负责取消并释放连接。
        const iterable = sseFrames(body, maxFrameBytes, () => {
          if (handle.fired() === "aborted") return true;
          return request.signal?.aborted === true;
        }, cancelable.signal);
        /**
         * 幂等的流级取消：让挂起的读立即结束，并真正释放上游连接。
         *
         * 异步生成器是**惰性**的：在第一次 `next()` 之前它的函数体从未运行，
         * 既没有 reader，也不会响应 `cancelable`（`onCancel` 还没注册）。所以这里必须
         * 自己取消**尚未加锁**的 body；否则 `return()` 会返回 `done`，但 HTTP 响应体与
         * 连接会永远挂着（建立阶段的 deadline 已被 `established()` 停掉，没有第二个
         * 东西会来收尾）。生成器一旦启动，body 已被它的 reader 锁定，`body.cancel()`
         * 会因 locked 而无效，取消改由 `sseFrames.onCancel` 的 `reader.cancel()` 负责。
         */
        let generatorStarted = false;
        const cancelStream = (): void => {
          if (cancelable.signal.aborted) return;
          cancelable.abort();
          if (!generatorStarted) void body.cancel().catch(() => undefined);
        };
        /** 所有资源**恰好一次**释放：停定时器/摘掉调用方 signal 桥接、取消上游、断读循环。 */
        let disposed = false;
        const disposeStream = (): void => {
          if (disposed) return;
          disposed = true;
          handle.signal.removeEventListener("abort", cancelStream);
          handle.dispose();
          cancelStream();
        };
        // 这里只桥接**响应头到达之后**的 abort（撤权/浏览器断开/进程关闭），流的建立结果
        // 已经确定：按 ADR-0032 §5，流阶段的 abort 只结束迭代，不把已成功的 `ok` 改写成失败。
        // 建立阶段的失败（fetch 因超时/父级 abort 而拒绝，或在上面的 `fired` 检查里被判定）
        // 在此之前就已经返回，不会走到这个监听器。
        handle.signal.addEventListener("abort", cancelStream, { once: true });
        if (handle.signal.aborted) cancelStream();
        const iterator = iterable[Symbol.asyncIterator]();
        return {
          ok: true,
          value: {
            [Symbol.asyncIterator](): AsyncIterator<DriverSseFrame> {
              return {
                async next(): Promise<IteratorResult<DriverSseFrame>> {
                  generatorStarted = true;
                  try {
                    const result = await iterator.next();
                    if (result.done === true) disposeStream();
                    return result;
                  } catch (error) {
                    disposeStream();
                    throw error;
                  }
                },
                async return(value?: unknown): Promise<IteratorResult<DriverSseFrame>> {
                  // 先**同步**取消（未启动时取消 body，已启动时取消 reader，挂起的 read 会
                  // 以 done 结束），再让生成器收尾：否则空闲会话上的 `return()` 会一直挂
                  // 在那个永不落定的 read 上。
                  disposeStream();
                  if (!generatorStarted) return { done: true, value: undefined };
                  try {
                    return await iterator.return(value as never);
                  } catch {
                    return { done: true, value: undefined };
                  }
                },
                async throw(error?: unknown): Promise<IteratorResult<DriverSseFrame>> {
                  // 与 return() 对称：未启动时生成器的函数体不会运行（throw 直接以该错误
                  // 拒绝，finally 也不会执行），因此必须先在这里取消尚未加锁的 body；
                  // 已启动时交由 sseFrames 的 reader.cancel() 收尾。
                  disposeStream();
                  if (!generatorStarted) throw error;
                  generatorStarted = true;
                  return await iterator.throw(error as never);
                },
              };
            },
          },
        };
      } catch {
        const outcome = handle.fired() !== undefined
          ? abortOutcome(handle)
          : unreachableFailure();
        handle.dispose();
        return outcome;
      }
    },

    async revoke(cell, notice, request = {}) {
      const body = Buffer.from(JSON.stringify({ sid: notice.sid, rev: notice.rev, reason: notice.reason }), "utf8");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cell.serviceToken !== undefined) headers["authorization"] = `Bearer ${cell.serviceToken}`;
      const result = await jsonRequest(
        cell,
        "/v1/admin/revoke",
        { method: "POST", headers, body },
        request,
        (value): DriverRevokeResponse | undefined => {
          if (value === null || typeof value !== "object") return undefined;
          const record = value as Record<string, unknown>;
          const sid = record["sid"];
          const rev = record["rev"];
          const accepted = record["accepted"];
          if (typeof accepted !== "boolean" || typeof sid !== "string" || typeof rev !== "number" || !Number.isSafeInteger(rev)) return undefined;
          const reason = record["reason"];
          const disposed = record["disposed"];
          const closedStreams = record["closedStreams"];
          return {
            accepted,
            sid,
            rev,
            reason: typeof reason === "string" ? reason : accepted ? "accepted" : "rejected",
            ...(typeof disposed === "boolean" ? { disposed } : {}),
            ...(typeof closedStreams === "number" && Number.isSafeInteger(closedStreams) ? { closedStreams } : {}),
          };
        },
      );
      return result.ok ? { ok: true, value: result.value as DriverRevokeResponse } : result;
    },
  };
}

/**
 * 有界 SSE 帧解析。
 *
 * 语义（与 driver 的 `encodeSseFrame` 对称）：
 *   * `id:` 只有持久事件才有；值即 `seq`。
 *   * `event:` 是 DSH 事件类型或 `myrix/*` 控制帧；缺省按 `message`。
 *   * `data:` 是一整行 JSON；多行 data 按 SSE 规范用 `\n` 连接（首版不会出现）。
 *   * `:` 开头是注释（心跳）。
 *   * 空行结束一帧。
 *
 * 上限保护：单帧超过 `maxFrameBytes` 直接抛出并结束迭代（调用方据此断开并续传），
 * 绝不无限累积。任何提前退出（超限抛错 / `isAborted()` / 调用方 `return()`）都在
 * finally 里 **cancel** reader，而不是只 `releaseLock()` —— 后者会留下一个没人读的
 * 上游连接继续接收数据。
 *
 * `cancelSignal`（可选）：一旦 abort，**同步** `reader.cancel()` 并停止解码。
 * 生成器运行在异步函数里，调用方 `return()` 时挂起的 `reader.read()` 不会自己落定；
 * 由外部信号驱动取消后，`return()` 也就在 cancel 处理完成时收敛，而不是无限等待。
 * 取消导致的 `reader.read()` 拒绝同样按"结束"处理并走 finally 的清理路径。
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
  isAborted: () => boolean,
  cancelSignal?: AbortSignal,
): AsyncGenerator<DriverSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let id: number | undefined;
  let event = "";
  let data: string[] = [];
  let size = 0;
  let completed = false;
  let canceled = false;
  const onCancel = (): void => {
    if (canceled) return;
    canceled = true;
    // 关键：reader 已由本函数持有锁，此时 `body.cancel()` 会因 locked 而**拒绝**（无效）。
    // 只有 reader.cancel() 能立即让挂起的 read() 以 done 结束，从而让生成器收尾、
    // 让调用方的 `return()` 收敛，并真正释放上游连接。
    void reader.cancel().catch(() => undefined);
  };

  /** 读取一块；取消后立即按 EOF 结束（也容忍取消引发的读取拒绝）。 */
  const readChunk = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (canceled) return { done: true, value: undefined };
    try {
      return await reader.read();
    } catch (error) {
      if (canceled) return { done: true, value: undefined };
      throw error;
    }
  };

  const frame = (): DriverSseFrame | undefined => {
    if (data.length === 0 && event === "" && id === undefined) return undefined;
    const payload = data.join("\n");
    let parsed: unknown;
    let parseError = false;
    if (payload.length === 0) {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(payload);
      } catch {
        parseError = true;
      }
    }
    const result: DriverSseFrame = {
      event: event.length === 0 ? "message" : event,
      data: parsed,
      ...(id === undefined ? {} : { id }),
      ...(parseError ? { parseError: true } : {}),
    };
    id = undefined;
    event = "";
    data = [];
    size = 0;
    return result;
  };

  try {
    if (cancelSignal) {
      cancelSignal.addEventListener("abort", onCancel, { once: true });
      if (cancelSignal.aborted) onCancel();
    }
    for (;;) {
      const { done, value } = await readChunk();
      if (canceled) break;
      if (done) {
        completed = true;
        break;
      }
      if (isAborted()) return;
      if (value) buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) {
          const parsedFrame = frame();
          if (parsedFrame !== undefined) {
            yield parsedFrame;
            // 取消可能发生在 `yield` 挂起期间：恢复后立刻收尾，不再交付缓冲里的后续帧。
            if (canceled) return;
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let raw = colon === -1 ? "" : line.slice(colon + 1);
        if (raw.startsWith(" ")) raw = raw.slice(1);
        if (field === "id") {
          if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) id = Number(raw);
          continue;
        }
        if (field === "event") {
          event = raw.slice(0, 128);
          continue;
        }
        if (field === "data") {
          size += raw.length;
          if (size > maxFrameBytes) throw new Error("myrix-bff runtime: 单帧 SSE 事件超过上限，已断开事件流");
          data.push(raw);
          continue;
        }
        // retry / 未知字段：忽略（不影响事件语义）。
      }
    }
    // 取消发生时不再交付尾部帧（读循环是被外部打断的，不是自然 EOF）。
    const tail = canceled ? undefined : frame();
    if (tail !== undefined) yield tail;
  } finally {
    cancelSignal?.removeEventListener("abort", onCancel);
    buffer = "";
    data = [];
    if (!completed) {
      // 上限抛错 / 被 abort / 调用方提前 return：取消上游，释放连接。
      try {
        await reader.cancel();
      } catch {
        // reader 已释放或流已出错；忽略。
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // reader 已释放；忽略。
    }
  }
}
