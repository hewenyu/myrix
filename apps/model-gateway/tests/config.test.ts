import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, assertUpstreamUrl, resolveGatewayConfig } from "../src/config";

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

  it("默认输出上限不能超过硬上限", () => {
    expect(() => resolveGatewayConfig(env({ MYRIX_GATEWAY_MAX_OUTPUT_TOKENS: "100" }))).toThrow(/DEFAULT_MAX_OUTPUT_TOKENS/);
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
