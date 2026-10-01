/**
 * 上游模型 HTTP 客户端（OpenAI **Responses**）。
 *
 * 约束：
 * * 上游 URL / 模型 / 密钥**只能来自部署配置**（config.ts），客户端无法指定；
 * * 密钥缺失时 `configured === false`，调用方必须 503 —— 绝不降级成模拟响应；
 * * 只发我们构造的请求体与出站头，不转发任何客户端请求头（尤其 Authorization 与归因头）；
 * * **拒绝重定向**：`redirect: "error"`。一次 302 会把 `Authorization` 带到另一个
 *   主机上，等于泄露上游密钥；宁可失败也不跟随。
 * * 取消与超时由调用方（gateway.ts）合并成一个 signal 传进来；本模块不再自己设表，
 *   这样子流式响应体的整个生命周期都受同一个截止时间约束。
 */
import { isAbortError, upstreamFailed } from "./errors";

export interface UpstreamSendInput {
  body: Record<string, unknown>;
  /** 合并后的取消信号（客户端断开 / 撤权 / 超时） */
  signal: AbortSignal;
  requestId: string;
}

export interface UpstreamClient {
  readonly url: string;
  readonly model: string;
  /** 是否已配置上游密钥；false 时调用方必须 503，不做任何降级 */
  readonly configured: boolean;
  send(input: UpstreamSendInput): Promise<Response>;
  /** 未配置时的可读原因（不含密钥） */
  describeMissing(): string | undefined;
}

export interface DeepSeekUpstreamOptions {
  url: string;
  model: string;
  apiKey?: string;
  /** 测试可注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 出站请求的服务标识 */
  userAgent?: string;
}

/** 合并多个 AbortSignal；任一 abort 即 abort 结果信号。 */
export function combineSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/**
 * 把上游响应体转成异步字节流；兼容 web ReadableStream。
 *
 * 提前退出（`break`/`return`/抛错）时**必须 cancel**：只 `releaseLock()` 会让上游
 * 继续往一个没人读的流里写，既浪费上游额度，也让 abort 不能立刻传导。
 */
export async function* readResponseBody(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value) yield value;
    }
  } finally {
    try {
      if (!finished) await reader.cancel();
    } catch {
      // 已取消/已关闭时 cancel 可能抛错，忽略
    }
    try {
      reader.releaseLock();
    } catch {
      // reader 已被取消时 releaseLock 可能抛错，忽略
    }
  }
}

export function createDeepSeekUpstream(options: DeepSeekUpstreamOptions): UpstreamClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("运行环境缺少 fetch：无法访问上游模型");
  const apiKey = options.apiKey;
  const userAgent = options.userAgent ?? "myrix-model-gateway/0.2.0";
  const configured = typeof apiKey === "string" && apiKey.length > 0;

  return {
    url: options.url,
    model: options.model,
    configured,
    describeMissing(): string | undefined {
      return configured
        ? undefined
        : "模型网关未配置上游密钥（MYRIX_GATEWAY_UPSTREAM_API_KEY 为空），拒绝调用；不存在本地模拟模型降级路径";
    },
    async send(input: UpstreamSendInput): Promise<Response> {
      if (!configured || typeof apiKey !== "string") {
        // 双保险：调用方应当已经 503；这里再挡一次，绝不发出无凭据请求。
        throw upstreamFailed(503, "上游密钥缺失");
      }
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${apiKey}`,
            "user-agent": userAgent,
            "x-myrix-request-id": input.requestId,
          },
          body: JSON.stringify(input.body),
          signal: input.signal,
          // 拒绝跟随重定向：跟随会把 Authorization 送到别的 origin（泄露上游密钥）。
          redirect: "error",
        });
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) throw error;
        // 不回显上游异常 message（可能含 URL/主机名）；只给固定的分类文案。
        throw upstreamFailed(502, "无法连接上游模型（网络错误、连接被拒或被重定向拒绝）");
      }
      if (response.status >= 300 && response.status < 400) {
        // fetch(redirect:"error") 在多数实现里会直接抛错；这里再挡一次，
        // 确保即使实现返回了 3xx 也绝不读取/跟随它。
        throw upstreamFailed(502, "上游返回了重定向；网关拒绝跟随（避免密钥被带到其他 origin）");
      }
      return response;
    },
  };
}
