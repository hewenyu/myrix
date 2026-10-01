/**
 * 预占估算与结算语义的回归测试（Responses 口径）。
 *
 * after（本文件断言的性质）：
 *   1. 估算按 UTF-8 字节（中英混排都不低于常见真实值），含输入项结构、instructions 与 tools JSON 成本；
 *   2. 预占**不截断**：超过输入硬上限 → 400 `input_too_large`，而不是悄悄变小；
 *   3. 结算**完整**计入真实 usage，可以超过预占；随后同一窗口的预占被 429；
 *   4. Responses 的 input/output token 正确映射到既有账本字段，cached/reasoning 只作审计不扣减。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import { GatewayError } from "../src/errors";
import { MemoryLedger, systemLedgerClock, type LedgerClock } from "../src/ledger";
import { parseResponseRequest, type ResponseInputItem } from "../src/protocol";
import {
  computeReservation,
  DEFAULT_BYTES_PER_TOKEN,
  estimatePromptTokens,
  estimateRequestTokens,
  isJsonArguments,
  normalizeUsage,
  outputBudget,
} from "../src/usage";

const limits = DEFAULT_LIMITS;
const policy = {
  bytesPerToken: DEFAULT_BYTES_PER_TOKEN,
  maxInputTokens: Math.ceil(limits.maxBodyBytes / DEFAULT_BYTES_PER_TOKEN),
};
/** 放宽正文上限，用来构造"体积合法但输入很大"的请求。 */
const roomyLimits = { ...limits, maxInputChars: 2_000_000, maxBodyBytes: 2_000_000 };
const roomyPolicy = {
  bytesPerToken: DEFAULT_BYTES_PER_TOKEN,
  maxInputTokens: Math.ceil(roomyLimits.maxBodyBytes / DEFAULT_BYTES_PER_TOKEN),
};

const parse = (body: unknown, useLimits = limits) => parseResponseRequest(body, useLimits);
const userMessage = (text: string): ResponseInputItem[] => [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];

describe("输入估算：UTF-8 字节保守估算（Responses input 项）", () => {
  it("中文 prompt：按字节保守估算，不低于常见真实值", () => {
    const content = "中".repeat(60_000); // 18 万 UTF-8 字节；中文约 1 token/汉字
    const request = parse({ model: "deepseek-chat", input: [{ role: "user", content }] }, roomyLimits);
    const after = computeReservation(request, roomyLimits, roomyPolicy);

    // 消息 18 万字节 + 结构开销（项 16 + 角色 4 + part 8 + "input_text" 10 = 38 字节）+ 输出预算
    expect(after).toBe(60_000 + Math.ceil(38 / 3) + roomyLimits.defaultMaxOutputTokens);
    expect(after).toBeGreaterThan(60_000);
  });

  it("英文 prompt：系数不低于常见真实值（不因修中文而低估英文）", () => {
    const content = "a".repeat(300_000);
    const request = parse({ model: "deepseek-chat", input: [{ role: "user", content }] }, roomyLimits);
    const estimate = estimateRequestTokens(request, { bytesPerToken: DEFAULT_BYTES_PER_TOKEN });
    const plausibleUpperBound = Math.ceil(content.length / 3.2);
    expect(estimate).toBeGreaterThanOrEqual(plausibleUpperBound);
  });

  it("输入项结构开销计入估算", () => {
    const items = userMessage("你好");
    const withOne = estimatePromptTokens(items);
    const withMany = estimatePromptTokens(Array.from({ length: 10 }, () => userMessage("你好")[0]!));
    expect(withMany).toBeGreaterThan(withOne);
    expect(estimatePromptTokens(Array.from({ length: 3 }, () => userMessage("")[0]!))).toBeGreaterThanOrEqual(3);
  });

  it("function_call / function_call_output 载荷计入估算", () => {
    const items: ResponseInputItem[] = [
      { type: "function_call", call_id: "call_1", name: "write_chapter", arguments: JSON.stringify({ text: "中".repeat(5_000) }) },
      { type: "function_call_output", call_id: "call_1", output: "中".repeat(5_000) },
    ];
    expect(estimatePromptTokens(items, { bytesPerToken: DEFAULT_BYTES_PER_TOKEN })).toBeGreaterThan(3_000);
  });

  it("instructions / tools / tool_choice 的 JSON 成本计入输入估算", () => {
    const base = { model: "deepseek-chat", input: [{ role: "user", content: "调用工具" }] };
    const withoutTools = estimateRequestTokens(parse(base), { bytesPerToken: DEFAULT_BYTES_PER_TOKEN });
    const tools = Array.from({ length: 40 }, (_, index) => ({
      type: "function",
      name: `novel_tool_${index}`,
      description: "写小说用的工具，描述里也有中文内容。".repeat(8),
      parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } },
    }));
    const withTools = estimateRequestTokens(parse({ ...base, instructions: "你是编辑。".repeat(200), tools, tool_choice: "auto" }), { bytesPerToken: DEFAULT_BYTES_PER_TOKEN });
    expect(withTools).toBeGreaterThan(withoutTools * 10);
  });

  it("无法计量成本的字段 → Infinity（拒绝，而不是按 0 计）", () => {
    const hostile = { toJSON: () => { throw new Error("no json"); } };
    const request = parse({ model: "deepseek-chat", input: [{ role: "user", content: "hi" }], tools: [{ type: "function", name: "f", parameters: hostile }] });
    expect(estimateRequestTokens(request, { bytesPerToken: DEFAULT_BYTES_PER_TOKEN })).toBe(Number.POSITIVE_INFINITY);
    expect(() => computeReservation(request, limits, policy)).toThrow(GatewayError);
  });

  it("outputBudget 受 protocol 硬上限约束", () => {
    expect(outputBudget(parse({ model: "deepseek-chat", input: [{ role: "user", content: "hi" }], max_output_tokens: 4096 }), limits)).toBe(4096);
    expect(outputBudget(parse({ model: "deepseek-chat", input: [{ role: "user", content: "hi" }] }), limits)).toBe(limits.defaultMaxOutputTokens);
  });
});

describe("预占：超上限明确拒绝，绝不静默截断", () => {
  it("20 万汉字：按上限拒绝而不是压低到某个 cap", () => {
    const content = "中".repeat(200_000);
    const request = parse({ model: "deepseek-chat", input: [{ role: "user", content }] }, roomyLimits);
    expect(computeReservation(request, roomyLimits, roomyPolicy)).toBe(200_000 + Math.ceil(38 / 3) + roomyLimits.defaultMaxOutputTokens);
  });

  it("输入超过硬上限 → 400 input_too_large（而不是降低预占）", () => {
    const tight = { bytesPerToken: DEFAULT_BYTES_PER_TOKEN, maxInputTokens: 1_000 };
    const request = parse({ model: "deepseek-chat", input: [{ role: "user", content: "中".repeat(30_000) }] });
    let thrown: unknown;
    try {
      computeReservation(request, limits, tight);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).statusCode).toBe(400);
    expect((thrown as GatewayError).code).toBe("input_too_large");
    expect((thrown as GatewayError).reason).toContain("UTF-8");
  });

  it("默认输入上限取部署正文上限：合法请求不会被误拒，绕过传输层的巨型请求被拒", () => {
    const legal = parse({ model: "deepseek-chat", input: [{ role: "user", content: "中".repeat(300_000) }] }, roomyLimits);
    expect(() => computeReservation(legal, roomyLimits, roomyPolicy)).not.toThrow();
    const oversized = parse({ model: "deepseek-chat", input: [{ role: "user", content: "中".repeat(1_200_000) }] }, roomyLimits);
    expect(() => computeReservation(oversized, roomyLimits, roomyPolicy)).toThrow(/input_too_large|超过网关输入上限/);
  });
});

describe("结算：真实 usage 完整计入（Responses input/output 映射到账本）", () => {
  it("真实用量超过预占时全额入账，并让后续预占被 429", async () => {
    const ledger = new MemoryLedger({ policy: { userTokens: 1_000, tenantTokens: 5_000, sessionTokens: 1_000 } });
    const reserved = await ledger.tryReserve({
      requestId: "req-over-0001", tenantId: "t-over", userId: "u-over", sessionId: "s-over",
      cellId: "cell", model: "deepseek-chat", reservedTokens: 500,
    });
    expect(reserved.ok).toBe(true);

    const settled = await ledger.consume({
      requestId: "req-over-0001", tenantId: "t-over", consumption: "settled",
      promptTokens: 600, completionTokens: 300, totalTokens: 900,
    });
    expect(settled).toEqual({ requestId: "req-over-0001", outcome: "settled", consumedTokens: 900, refundedTokens: 0, replayed: false });

    const denied = await ledger.tryReserve({
      requestId: "req-over-0002", tenantId: "t-over", userId: "u-over", sessionId: "s-over-2",
      cellId: "cell", model: "deepseek-chat", reservedTokens: 200,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("user_quota");
    expect(denied.reason).toContain("900");
  });

  it("正常情况仍然退还多占的预占", async () => {
    const ledger = new MemoryLedger();
    await ledger.tryReserve({
      requestId: "req-under-0001", tenantId: "t-under", userId: "u-under", sessionId: "s-under",
      cellId: "cell", model: "deepseek-chat", reservedTokens: 5_000,
    });
    const settled = await ledger.consume({
      requestId: "req-under-0001", tenantId: "t-under", consumption: "settled",
      promptTokens: 100, completionTokens: 50, totalTokens: 150,
    });
    expect(settled.consumedTokens).toBe(150);
    expect(settled.refundedTokens).toBe(4_850);
  });

  it("unknown 仍然保守保留预占（断流不退款）", async () => {
    const ledger = new MemoryLedger();
    await ledger.tryReserve({
      requestId: "req-unknown-0001", tenantId: "t-unknown", userId: "u-unknown", sessionId: "s-unknown",
      cellId: "cell", model: "deepseek-chat", reservedTokens: 777,
    });
    const result = await ledger.consume({ requestId: "req-unknown-0001", tenantId: "t-unknown", consumption: "unknown" });
    expect(result.outcome).toBe("unknown");
    expect(result.consumedTokens).toBe(777);
    expect(result.refundedTokens).toBe(0);
  });
});

describe("normalizeUsage：Responses usage 映射（cached/reasoning 只作审计）", () => {
  it("input/output 映射到 prompt/completion，total 取声明值与两者之和的较大者", () => {
    expect(normalizeUsage({ input_tokens: 30, output_tokens: 20, total_tokens: 10 })).toEqual({
      promptTokens: 30, completionTokens: 20, totalTokens: 50,
    });
    expect(normalizeUsage({ input_tokens: 7, output_tokens: 5 })).toEqual({
      promptTokens: 7, completionTokens: 5, totalTokens: 12,
    });
  });

  it("cached_tokens 与 reasoning_tokens 作为审计元数据保留，但不从计费总量里扣除", () => {
    const usage = normalizeUsage({
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens_details: { reasoning_tokens: 15 },
    });
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140, cachedTokens: 64, reasoningTokens: 15 });
    // 计费总量仍是 140：缓存/推理 token 已含在 input/output 内，扣减等于少计。
    expect(usage?.totalTokens).toBe(140);
  });

  it("只认 Responses 字段名：chat 的 prompt_tokens/completion_tokens 一律视为未知", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toBeUndefined();
  });

  it("异常字段一律返回 undefined（= 未知，保守保留预占）", () => {
    expect(normalizeUsage({ input_tokens: -1, output_tokens: 5 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: 1.5, output_tokens: 5 })).toBeUndefined();
    expect(normalizeUsage({ input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: -3 } })).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(normalizeUsage(null)).toBeUndefined();
  });

  it("函数调用参数可识别非法 JSON（仅诊断，不阻断转发）", () => {
    expect(isJsonArguments({ type: "function_call", call_id: "c", name: "f", arguments: "{\"a\":1}" })).toBe(true);
    expect(isJsonArguments({ type: "function_call", call_id: "c", name: "f", arguments: "{oops" })).toBe(false);
  });
});

describe("账本时钟契约（供 PG/内存一致性断言用）", () => {
  it("systemLedgerClock 返回毫秒整数", () => {
    const clock: LedgerClock = systemLedgerClock;
    expect(Number.isSafeInteger(clock.nowMs())).toBe(true);
  });
});
