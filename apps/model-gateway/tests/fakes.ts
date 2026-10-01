/**
 * 测试替身：明确记录收到的请求，返回脚本化的上游 Responses 响应。
 *
 * **这不是"模拟模型降级路径"**：它只存在于测试进程里，生产代码永远不会引用它。
 * 单测用它验证网关对 Responses 协议的处理（SSE 事件、usage、错误、abort、截断）。
 */
import type { UpstreamClient, UpstreamSendInput } from "../src/upstream";

export interface RecordedUpstreamCall {
  body: Record<string, unknown>;
  requestId: string;
  aborted: boolean;
  signalAbortedAtCall: boolean;
}

export interface FakeUpstreamOptions {
  /** 每次调用的响应工厂；可断言调用序号 */
  handler: (input: UpstreamSendInput, callIndex: number) => Response | Promise<Response>;
  url?: string;
  model?: string;
  configured?: boolean;
}

export class FakeUpstream implements UpstreamClient {
  readonly url: string;
  readonly model: string;
  readonly configured: boolean;
  readonly calls: RecordedUpstreamCall[] = [];
  readonly #options: FakeUpstreamOptions;

  constructor(options: FakeUpstreamOptions) {
    this.#options = options;
    this.url = options.url ?? "https://fake-upstream.invalid/v1/responses";
    this.model = options.model ?? "deepseek-chat";
    this.configured = options.configured ?? true;
  }

  describeMissing(): string | undefined {
    return this.configured ? undefined : "未配置上游密钥（测试替身）";
  }

  async send(input: UpstreamSendInput): Promise<Response> {
    const record: RecordedUpstreamCall = {
      body: input.body,
      requestId: input.requestId,
      aborted: false,
      signalAbortedAtCall: input.signal.aborted,
    };
    this.calls.push(record);
    input.signal.addEventListener("abort", () => {
      record.aborted = true;
    }, { once: true });
    if (input.signal.aborted) {
      // 与真实 fetch 一致：信号已 abort 时立刻拒绝，不发出请求。
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return this.#options.handler(input, this.calls.length - 1);
  }
}

/** 用给定字节块构造一个 SSE 响应体。 */
export function sseResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

/**
 * 一个"永不结束"的 SSE 响应，用于测试 abort / 撤权轮询。
 * 真实 fetch 在信号 abort 时会让 body 读取失败，这里显式模拟同样的行为，
 * 否则测试会一直等一个永远不会结束的流。
 */
export function hangingSseResponse(
  firstChunks: readonly string[] = [],
  signal?: AbortSignal,
): { response: Response; closed: () => boolean; upstreamAborted: () => boolean } {
  const encoder = new TextEncoder();
  let closed = false;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of firstChunks) controller.enqueue(encoder.encode(chunk));
      signal?.addEventListener("abort", () => {
        aborted = true;
        try {
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        } catch {
          // 流已关闭
        }
      }, { once: true });
    },
    cancel() {
      closed = true;
    },
  });
  return { response: new Response(body, { status: 200 }), closed: () => closed, upstreamAborted: () => aborted };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 一个最小但完整的 Responses 非流式响应体。 */
export function responseBody(options: {
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  text?: string;
} = {}): Record<string, unknown> {
  const input = options.inputTokens ?? 12;
  const output = options.outputTokens ?? 34;
  return {
    id: "resp_fake",
    object: "response",
    created_at: 1_700_000_000,
    status: options.status ?? "completed",
    model: "deepseek-chat",
    output: [
      {
        type: "message",
        id: "msg_fake",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: options.text ?? "很久以前", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      ...(options.cachedTokens === undefined ? {} : { input_tokens_details: { cached_tokens: options.cachedTokens } }),
      ...(options.reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: options.reasoningTokens } }),
    },
  };
}

const RESPONSE_ID = "resp_fake";

export const sse = {
  created(): string {
    return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: RESPONSE_ID, status: "in_progress" } })}\n\n`;
  },
  outputItemAdded(item: Record<string, unknown>, outputIndex = 0): string {
    return `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: outputIndex, item: { id: `${RESPONSE_ID}_item`, ...item } })}\n\n`;
  },
  textDelta(delta: string, outputIndex = 0): string {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: outputIndex, item_id: `${RESPONSE_ID}_item`, content_index: 0, delta })}\n\n`;
  },
  functionCallArgumentsDelta(delta: string, itemId = `${RESPONSE_ID}_item`): string {
    return `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", sequence_number: 3, item_id: itemId, output_index: 0, delta })}\n\n`;
  },
  functionCallArgumentsDone(argumentsText: string, itemId = `${RESPONSE_ID}_item`): string {
    return `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", sequence_number: 4, item_id: itemId, output_index: 0, arguments: argumentsText })}\n\n`;
  },
  outputItemDone(item: Record<string, unknown>, outputIndex = 0): string {
    return `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 5, output_index: outputIndex, item })}\n\n`;
  },
  completed(usage: Record<string, unknown> = { input_tokens: 12, output_tokens: 34, total_tokens: 46 }): string {
    return `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 9, response: { id: RESPONSE_ID, status: "completed", usage } })}\n\n`;
  },
  incomplete(usage: Record<string, unknown> = { input_tokens: 12, output_tokens: 8, total_tokens: 20 }): string {
    return `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", sequence_number: 9, response: { id: RESPONSE_ID, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } })}\n\n`;
  },
  failed(usage?: Record<string, unknown>): string {
    return `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: 9, response: { id: RESPONSE_ID, status: "failed", ...(usage === undefined ? {} : { usage }) } })}\n\n`;
  },
  providerError(message = "upstream exploded", code = "server_error"): string {
    return `event: error\ndata: ${JSON.stringify({ type: "error", code, message })}\n\n`;
  },
};

/** 收集异步字符串流。 */
export async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}
