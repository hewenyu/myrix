import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS, assertUpstreamUrl, resolveGatewayConfig } from "../src/config";

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  MYRIX_GATEWAY_UPSTREAM_URL: "https://api.deepseek.example/v1/responses",
  MYRIX_GATEWAY_UPSTREAM_MODEL: "deepseek-chat",
  MYRIX_GATEWAY_UPSTREAM_API_KEY: "sk-live-secret",
  ...overrides,
});

describe("网关配置（没有默认上游 / 没有默认密钥 / 没有默认模型）", () => {
  it("缺少上游 URL 或模型名 → 启动即失败", () => {
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_UPSTREAM_URL: undefined }))).toThrow(/UPSTREAM_URL/);
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_UPSTREAM_MODEL: undefined }))).toThrow(/UPSTREAM_MODEL/);
  });

  it("缺少密钥不阻止启动，但记录为未配置（请求时 503，不做模拟降级）", () => {
    const config = resolveGatewayConfig(env({ MYRIX_GATEWAY_UPSTREAM_API_KEY: undefined }));
    expect(config.upstream.apiKey).toBeUndefined();
    expect(config.modelAllowlist).toEqual(["deepseek-chat"]);
  });

  it("allowlist 必须包含部署指定的上游模型", () => {
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_MODEL_ALLOWLIST: "other-model" }))).toThrow(/必须包含/);
    const config = resolveGatewayConfig(env({ MYRIX_GATEWAY_MODEL_ALLOWLIST: "deepseek-chat, deepseek-reasoner" }));
    expect(config.modelAllowlist).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("上游必须是 https（仅 loopback 允许 http），且必须是完整 /responses 端点", () => {
    expect(() => assertUpstreamUrl("http://evil.example/v1/responses")).toThrow(/https/);
    expect(assertUpstreamUrl("http://127.0.0.1:3123/v1/responses")).toBe("http://127.0.0.1:3123/v1/responses");
    expect(assertUpstreamUrl("https://api.deepseek.com/v1/responses")).toContain("https://");
    // 只给 base URL 不做路径补全；写错端点启动即拒绝。
    expect(() => assertUpstreamUrl("https://api.deepseek.com/v1")).toThrow(/\/responses/);
    expect(() => assertUpstreamUrl("https://api.deepseek.com")).toThrow(/\/responses/);
  });

  it("上游 URL 指向 chat/completions 一律拒绝（仓库禁止该协议）", () => {
    expect(() => assertUpstreamUrl("https://api.deepseek.com/v1/chat/completions")).toThrow(/chat\/completions|responses/);
    expect(() => assertUpstreamUrl("http://127.0.0.1:3123/v1/chat/completions")).toThrow(/chat\/completions|responses/);
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_UPSTREAM_URL: "https://api.deepseek.com/v1/chat/completions" }))).toThrow(/chat\/completions|responses/);
  });

  it("上游 URL 不接受查询串/fragment（避免把参数夹带进上游请求）", () => {
    expect(() => assertUpstreamUrl("https://api.deepseek.com/v1/responses?key=x")).toThrow(/查询串/);
    expect(() => assertUpstreamUrl("https://api.deepseek.com/v1/responses#frag")).toThrow(/查询串/);
  });

  it("禁止把认证凭据夹在上游 URL 中，错误不能回显凭据", () => {
    for (const url of ["https://private-user:private-password@api.example/v1/responses", "https://private-token@api.example/v1/responses"]) {
      expect(() => assertUpstreamUrl(url)).toThrow(/不得携带/);
      try { assertUpstreamUrl(url); } catch (error) {
        expect(String(error)).not.toContain("private-");
      }
    }
  });

  it("未显式配置默认输出预算时取实用默认（= 硬上限 8192），且被硬上限收窄", () => {
    // 024c74c9 回归：默认 1024 在带工具调用的真实回合里被推理 token 吃光，
    // 上游以 incomplete(reason=length) 结束。未显式配置时默认必须回到硬上限。
    const defaults = resolveGatewayConfig(env());
    expect(defaults.limits.maxOutputTokens).toBe(8192);
    expect(defaults.limits.defaultMaxOutputTokens).toBe(8192);
    expect(defaults.limits.defaultMaxOutputTokens).toBe(PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(DEFAULT_LIMITS.defaultMaxOutputTokens).toBe(8192);

    // 只调低硬上限：隐式默认随硬上限一起收窄（不会留下一个超过硬上限的默认值）。
    const lowHard = resolveGatewayConfig(env({ MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "100" }));
    expect(lowHard.limits.maxOutputTokens).toBe(100);
    expect(lowHard.limits.defaultMaxOutputTokens).toBe(100);

    // 硬上限调**高**时隐式默认**不跟随**：仍是 8192，不会随硬上限一起放大。
    const highHard = resolveGatewayConfig(env({ MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "16384" }));
    expect(highHard.limits.maxOutputTokens).toBe(16384);
    expect(highHard.limits.defaultMaxOutputTokens).toBe(PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(highHard.limits.defaultMaxOutputTokens).toBe(8192);
    expect(highHard.limits.defaultMaxOutputTokens).toBeLessThanOrEqual(highHard.limits.maxOutputTokens);
  });

  it("overrides.limits 参与生效硬上限：隐式默认取 min(8192, 生效硬上限)，不被 env 硬上限误算", () => {
    const fixture: NodeJS.ProcessEnv = {
      MYRIX_GATEWAY_UPSTREAM_URL: "https://fixture.invalid/v1/responses",
      MYRIX_GATEWAY_UPSTREAM_MODEL: "fixture",
    };

    // 回归：override 单独把硬上限压到 2048，env 未配置硬上限（隐式 8192）。
    // 旧实现先按 env 算出隐式默认 8192，再被 override 硬上限 2048 判为非法而抛错。
    const lowOverride = resolveGatewayConfig(fixture, { limits: { maxOutputTokens: 2048 } });
    expect(lowOverride.limits.maxOutputTokens).toBe(2048);
    expect(lowOverride.limits.defaultMaxOutputTokens).toBe(2048);

    // override 把硬上限抬高：隐式默认仍封顶在实用默认 8192，不随之上浮。
    const highOverride = resolveGatewayConfig(fixture, { limits: { maxOutputTokens: 16_384 } });
    expect(highOverride.limits.maxOutputTokens).toBe(16_384);
    expect(highOverride.limits.defaultMaxOutputTokens).toBe(PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS);

    // 生效硬上限取 override 值：env 调低硬上限不影响 override 的最终语义。
    const envLowOverrideHigh = resolveGatewayConfig(
      env({ MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "2048" }),
      { limits: { maxOutputTokens: 16_384 } },
    );
    expect(envLowOverrideHigh.limits.maxOutputTokens).toBe(16_384);
    expect(envLowOverrideHigh.limits.defaultMaxOutputTokens).toBe(8192);

    // override 显式默认原样生效，且优先于隐式默认（0 < 512 < 生效硬上限 2048）。
    const explicitOverride = resolveGatewayConfig(fixture, {
      limits: { maxOutputTokens: 2048, defaultMaxOutputTokens: 512 },
    });
    expect(explicitOverride.limits.defaultMaxOutputTokens).toBe(512);
  });

  it("显式默认与生效硬上限冲突一律拒绝（两个方向），不做静默压低", () => {
    const fixture: NodeJS.ProcessEnv = {
      MYRIX_GATEWAY_UPSTREAM_URL: "https://fixture.invalid/v1/responses",
      MYRIX_GATEWAY_UPSTREAM_MODEL: "fixture",
    };

    // env 显式默认 4096 + override 硬上限 2048（最终 spread 的硬上限）：拒绝。
    expect(() => resolveGatewayConfig(
      env({ MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "4096" }),
      { limits: { maxOutputTokens: 2048 } },
    )).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);

    // 反方向：env 硬上限 2048 + override 显式默认 4096：同样拒绝。
    expect(() => resolveGatewayConfig(
      env({ MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "2048" }),
      { limits: { defaultMaxOutputTokens: 4096 } },
    )).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);

    // override 自身冲突（显式默认 > override 硬上限）也拒绝。
    expect(() => resolveGatewayConfig(fixture, {
      limits: { maxOutputTokens: 2048, defaultMaxOutputTokens: 4096 },
    })).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);
  });

  it("显式配置的默认输出预算原样生效；显式默认大于硬上限仍然拒绝（fail-closed）", () => {
    // 显式默认照旧生效（不因为"实用默认"而被覆盖）。
    const explicit = resolveGatewayConfig(env({
      MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "2048",
      MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "512",
    }));
    expect(explicit.limits.defaultMaxOutputTokens).toBe(512);

    // 显式默认可以等于硬上限（边界合法）。
    expect(resolveGatewayConfig(env({
      MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "2048",
      MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "2048",
    })).limits.defaultMaxOutputTokens).toBe(2048);

    // 大于硬上限：显式配置的错误必须报出来，不静默压低成硬上限。
    expect(() => resolveGatewayConfig(env({
      MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "100",
      MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "200",
    }))).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);
    expect(() => resolveGatewayConfig(env({
      MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "8192",
      MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "9000",
    }))).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);
  });

  it("部署默认值不会削弱其它额度/输入限制", () => {
    const config = resolveGatewayConfig(env());
    // 输入、正文与超时上限完全不变：这次只调整"输出预算"这一项。
    expect(config.limits.maxInputItems).toBe(DEFAULT_LIMITS.maxInputItems);
    expect(config.limits.maxInputChars).toBe(DEFAULT_LIMITS.maxInputChars);
    expect(config.limits.maxBodyBytes).toBe(DEFAULT_LIMITS.maxBodyBytes);
    expect(config.limits.upstreamTimeoutMs).toBe(DEFAULT_LIMITS.upstreamTimeoutMs);
    // 输出预算恒被硬上限收窄（不存在"无上限"路径）。
    expect(config.limits.defaultMaxOutputTokens).toBeLessThanOrEqual(config.limits.maxOutputTokens);
  });

  it("开发凭据表只在非生产可用，且要求令牌有足够熵", () => {
    const raw = JSON.stringify({ "dev-token-0123456789": { tenantId: "t1", cellId: "cell-1" } });
    const config = resolveGatewayConfig(env({ MYRIX_GATEWAY_CREDENTIAL_SOURCE: "env", MYRIX_GATEWAY_DEV_CREDENTIALS: raw }));
    expect(config.envCredentials["dev-token-0123456789"]).toEqual({ tenantId: "t1", cellId: "cell-1" });

    expect(() => resolveGatewayConfig(env({
      NODE_ENV: "production",
      MYRIX_GATEWAY_CREDENTIAL_SOURCE: "env",
      MYRIX_GATEWAY_DEV_CREDENTIALS: raw,
    }))).toThrow(/不允许在 production/);

    expect(() => resolveGatewayConfig(env({
      MYRIX_GATEWAY_CREDENTIAL_SOURCE: "env",
      MYRIX_GATEWAY_DEV_CREDENTIALS: JSON.stringify({ short: { tenantId: "t1", cellId: "c" } }),
    }))).toThrow(/至少 16 个字符/);
  });

  it("限制项来自环境变量并保持类型安全", () => {
    const config = resolveGatewayConfig(env({
      MYRIX_GATEWAY_MAX_BODY_BYTES: "2048",
      MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "2048",
      MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: "512",
      MYRIX_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
    }));
    expect(config.limits.maxBodyBytes).toBe(2048);
    expect(config.limits.maxOutputTokens).toBe(2048);
    expect(config.limits.defaultMaxOutputTokens).toBe(512);
    expect(config.limits.upstreamTimeoutMs).toBe(5000);
    expect(DEFAULT_LIMITS.revokePollMs).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxSseEventBytes).toBeGreaterThan(0);
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_MAX_BODY_BYTES: "abc" }))).toThrow(/正整数/);
  });

  it("不打印/不暴露密钥：配置对象里只有 upstream.apiKey 一处持有它", () => {
    const config = resolveGatewayConfig(env());
    const serialized = JSON.stringify(config);
    expect(serialized).toContain("sk-live-secret");
    expect(Object.keys(config.upstream).sort()).toEqual(["apiKey", "model", "url"]);
  });
});
