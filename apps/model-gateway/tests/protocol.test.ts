import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SSE_EVENT_BYTES,
  formatSseEvent,
  hasTerminalStatus,
  isTerminalEvent,
  parseResponseRequest,
  parseSse,
  streamErrorEvent,
  toUpstreamBody,
  type RequestValidationLimits,
} from "../src/protocol";
import { GatewayError } from "../src/errors";

const limits: RequestValidationLimits = {
  maxOutputTokens: 8192,
  // 与部署默认一致：未显式配置时"实用默认" = 硬上限（024c74c9 回归）。
  defaultMaxOutputTokens: 8192,
  maxInputItems: 200,
  maxInputChars: 100_000,
};

const base = { model: "deepseek-chat", input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }] };
const expectReject = (body: unknown, match: RegExp): void => {
  try {
    parseResponseRequest(body, limits);
    throw new Error("应当拒绝但没有拒绝");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).statusCode).toBe(400);
    expect((error as GatewayError).reason).toMatch(match);
  }
};

describe("Responses 请求校验（fail-closed）", () => {
  it("接受最小合法请求并把输出预算默认成上限内的值", () => {
    const parsed = parseResponseRequest(base, limits);
    expect(parsed.model).toBe("deepseek-chat");
    expect(parsed.stream).toBe(false);
    expect(parsed.maxOutputTokens).toBe(8192);
    expect(parsed.input).toHaveLength(1);
  });

  it("未显式给 max_output_tokens 时，恒向上游发默认预算（含 tools 的请求也一样）", () => {
    // 024c74c9：带工具调用的回合里，默认预算必须真的"写上线"，而不是只存在于本地对象。
    const withTools = {
      ...base,
      input: [
        { role: "user", content: "先取大纲再检索经文" },
        { type: "function_call", call_id: "call_1", name: "get_outline", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "{\"outline\":\"...\"}" },
      ],
      tools: [{ type: "function", name: "search_bible", description: "检索经文", parameters: { type: "object" } }],
      tool_choice: "auto",
    };
    const body = toUpstreamBody(parseResponseRequest(withTools, limits));
    expect(body.max_output_tokens).toBe(limits.defaultMaxOutputTokens);
    expect(body.max_output_tokens).toBe(limits.maxOutputTokens);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    // 仍然只发 Responses 字段：没有 chat 形状的残留。
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("max_tokens");

    // 显式值仍然原样透传（默认只在"缺省"时生效）。
    expect(toUpstreamBody(parseResponseRequest({ ...withTools, max_output_tokens: 4096 }, limits)).max_output_tokens).toBe(4096);
  });

  it("代表性推理预算（1024）不再被静默截断：预算覆盖推理+正文的输出上限", () => {
    // 事故里 output=1024 全部被 reasoning 吃掉、正文为空。默认预算必须显著高于
    // 一个典型推理回合的消耗（这里取 1024 作为代表性推理预算）。
    const representativeReasoningBudget = 1024;
    const parsed = parseResponseRequest(base, limits);
    expect(parsed.maxOutputTokens).toBeGreaterThan(representativeReasoningBudget);
    // 请求方仍然可以显式收窄（例如只要短回复），不受默认值影响。
    expect(parseResponseRequest({ ...base, max_output_tokens: representativeReasoningBudget }, limits).maxOutputTokens)
      .toBe(representativeReasoningBudget);
  });

  it("接受字符串 content 与 assistant 的 output_text 历史", () => {
    const parsed = parseResponseRequest({
      model: "deepseek-chat",
      input: [
        { role: "user", content: "写一段小说" },
        { role: "assistant", content: [{ type: "output_text", text: "很久以前" }] },
      ],
    }, limits);
    expect(parsed.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "写一段小说" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "很久以前" }] },
    ]);
  });

  it("拒绝未知顶层字段（防止夹带未治理参数）", () => {
    expectReject({ ...base, top_k: 5 }, /top_k/);
    expectReject({ ...base, api_key: "sk-x" }, /api_key/);
    expectReject({ ...base, messages: [] }, /messages/);
    expectReject({ ...base, max_tokens: 10 }, /max_tokens/);
  });

  it("拒绝把状态留在上游的字段：previous_response_id / conversation / background", () => {
    expectReject({ ...base, previous_response_id: "resp_1" }, /previous_response_id/);
    expectReject({ ...base, conversation: "conv_1" }, /conversation/);
    expectReject({ ...base, background: true }, /background/);
  });

  it("拒绝身份/客户端令牌覆盖字段", () => {
    expectReject({ ...base, user: "someone-else" }, /user/);
    expectReject({ ...base, metadata: { tenant: "other" } }, /metadata/);
    expectReject({ ...base, safety_identifier: "x" }, /safety_identifier/);
    expectReject({ ...base, prompt_cache_key: "x" }, /prompt_cache_key/);
  });

  it("无状态：store 只能是 false，缺省也按 false", () => {
    expect(parseResponseRequest({ ...base, store: false }, limits).stream).toBe(false);
    expectReject({ ...base, store: true }, /store 只能为 false/);
    expectReject({ ...base, store: "false" }, /store 必须是布尔值/);
    // 无论请求怎么写，转发给上游的一定是 store:false。
    expect(toUpstreamBody(parseResponseRequest(base, limits)).store).toBe(false);
  });

  it("拒绝超过硬上限的 max_output_tokens，不静默截断", () => {
    expectReject({ ...base, max_output_tokens: 9000 }, /硬上限 8192/);
    expectReject({ ...base, max_output_tokens: 0 }, /max_output_tokens/);
    expect(toUpstreamBody(parseResponseRequest({ ...base, max_output_tokens: 512 }, limits)).max_output_tokens).toBe(512);
  });

  it("校验 input 项结构：message / function_call / function_call_output", () => {
    expectReject({ ...base, input: [] }, /非空/);
    expectReject({ ...base, input: [{ role: "boss", content: "x" }] }, /role/);
    expectReject({ ...base, input: [{ role: "tool", content: "x" }] }, /role/);
    expectReject({ ...base, input: [{ type: "message", role: "user" }] }, /content/);
    expectReject({ ...base, input: [{ type: "reasoning", content: "x" }] }, /type 必须是/);
    expectReject({ ...base, input: [{ type: "function_call", name: "f" }] }, /call_id/);
    expectReject({ ...base, input: [{ type: "function_call", call_id: "c1" }] }, /name/);
    expectReject({ ...base, input: [{ type: "function_call", call_id: "c1", name: "f", arguments: {} }] }, /arguments 必须是 JSON 字符串/);
    expectReject({ ...base, input: [{ type: "function_call_output", call_id: "c1", output: { ok: true } }] }, /output 必须是字符串/);
  });

  it("拒绝图片/音频/文件等非文本内容块", () => {
    expectReject({ ...base, input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] }, /input_text\/output_text/);
    expectReject({ ...base, input: [{ role: "user", content: [{ type: "input_file", file_id: "x" }] }] }, /input_text\/output_text/);
  });

  it("接受标准 function_call / function_call_output 历史并原样转发", () => {
    const input = [
      { role: "user", content: "帮我写章节" },
      { type: "function_call", call_id: "call_1", name: "write_chapter", arguments: "{\"title\":\"x\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
    ];
    const parsed = parseResponseRequest({ model: "deepseek-chat", input }, limits);
    expect(parsed.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "帮我写章节" }] },
      { type: "function_call", call_id: "call_1", name: "write_chapter", arguments: "{\"title\":\"x\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
    ]);
  });

  it("接受 Responses 形状的 tools 定义并保留 strict", () => {
    const parsed = parseResponseRequest({
      ...base,
      tools: [{ type: "function", name: "write_chapter", description: "写章节", parameters: { type: "object" }, strict: true }],
      tool_choice: { type: "function", name: "write_chapter" },
    }, limits);
    expect(parsed.tools?.[0]).toEqual({ type: "function", name: "write_chapter", description: "写章节", parameters: { type: "object" }, strict: true });
    expect(parsed.toolChoice).toEqual({ type: "function", name: "write_chapter" });
    const body = toUpstreamBody(parsed);
    expect(body.tools).toEqual(parsed.tools);
    expect(body.tool_choice).toEqual({ type: "function", name: "write_chapter" });
  });

  it("拒绝非 function 工具、非法工具名与非法 tool_choice", () => {
    expectReject({ ...base, tools: [{ type: "web_search" }] }, /tools\[0\]\.type/);
    expectReject({ ...base, tools: [{ type: "function", name: "有中文" }] }, /工具名/);
    expectReject({ ...base, tools: [{ type: "function", name: "ok", parameters: [] }] }, /parameters/);
    expectReject({ ...base, model: "deepseek-chat", tool_choice: "sometimes" }, /tool_choice/);
    expectReject({ ...base, tool_choice: { type: "web_search" } }, /tool_choice/);
  });

  it("instructions 只接受有界字符串", () => {
    expect(parseResponseRequest({ ...base, instructions: "你是小说助手" }, limits).instructions).toBe("你是小说助手");
    expectReject({ ...base, instructions: 42 }, /instructions/);
    expectReject({ ...base, instructions: "x".repeat(100_001) }, /instructions/);
  });

  it("转发体只含已治理字段，模型名由部署配置决定", () => {
    const parsed = parseResponseRequest({ ...base, stream: true, max_output_tokens: 512, instructions: "hello" }, limits);
    const body = toUpstreamBody({ ...parsed, model: "cline-pass/deepseek-v4.1-flash" });
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "max_output_tokens", "model", "stream", "store"].sort());
    expect(body.model).toBe("cline-pass/deepseek-v4.1-flash");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("stream_options");
    expect(body).not.toHaveProperty("messages");
  });
});

describe("Responses SSE 有界帧解析", () => {
  const encoder = new TextEncoder();
  async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
    for (const value of values) yield encoder.encode(value);
  }

  it("解析 event: 与 data: 行，并保留事件名", async () => {
    const events = [];
    for await (const event of parseSse(chunks(
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"delta\":\"你\"}\n\n",
    ))) events.push(event);
    expect(events).toEqual([
      { event: "response.created", data: "{\"type\":\"response.created\"}" },
      { event: "response.output_text.delta", data: "{\"delta\":\"你\"}" },
    ]);
  });

  it("跨字节块拼接、兼容 CRLF、处理不完整尾块", async () => {
    const events = [];
    for await (const event of parseSse(chunks("event: response.comp", "leted\r\ndata: {\"a\":1}\r\n\r\n"))) events.push(event);
    expect(events).toEqual([{ event: "response.completed", data: "{\"a\":1}" }]);
  });

  it("单个事件超过上限 → SseFramingError（有界，不无限缓冲）", async () => {
    const huge = `data: ${"x".repeat(4096)}\n\n`;
    await expect(async () => {
      for await (const _event of parseSse(chunks(huge), { maxEventBytes: 1024 })) void _event;
    }).rejects.toThrow(/超过 1024 字节上限/);
    expect(DEFAULT_MAX_SSE_EVENT_BYTES).toBe(1024 * 1024);
  });
});

describe("Responses 终止语义与流内错误事件", () => {
  it("只有 completed 成功；incomplete/failed 是终态但不是成功", () => {
    expect(isTerminalEvent("response.completed")).toBe(true);
    expect(isTerminalEvent("response.incomplete")).toBe(true);
    expect(isTerminalEvent("response.failed")).toBe(true);
    expect(isTerminalEvent("response.output_text.delta")).toBe(false);
    expect(hasTerminalStatus({ status: "completed" })).toBe(true);
    expect(hasTerminalStatus({ status: "in_progress" })).toBe(false);
    expect(hasTerminalStatus({})).toBe(false);
  });

  it("网关流内错误用 Responses 的 error 事件，且不含上游原文", () => {
    const payload = streamErrorEvent("upstream_truncated", "上游流在终态事件之前断开");
    expect(payload.startsWith("event: error\ndata: ")).toBe(true);
    const parsed = JSON.parse(payload.slice("event: error\ndata: ".length).trim()) as { type: string; code: string; message: string };
    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("upstream_truncated");
    expect(Object.keys(parsed).sort()).toEqual(["code", "message", "type"]);
    expect(formatSseEvent("response.completed", "{}")).toBe("event: response.completed\ndata: {}\n\n");
  });
});
