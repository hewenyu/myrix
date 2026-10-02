/**
 * 网关配置。全部来自环境变量；**没有默认上游、没有默认密钥、没有默认模型**。
 *
 * fail-closed：
 * * 上游 URL / 模型名未配置 → 启动即失败（配置错误属于部署错误，不应该等到请求时才炸）；
 * * 上游密钥缺失 → 服务可以起来（便于探活与灰度），但 `/v1/responses` 一律 503，
 *   绝不会退化成"本地模拟响应"。模拟上游只存在于测试里（tests/fakes）。
 *
 * 协议：上游是 **OpenAI Responses** 的**完整** `/responses` URL。
 * 仓库硬性规则禁止 `chat/completions`，因此这里既不做路径补全、也不接受
 * chat/completions 端点 —— 配置写错就在启动时拒绝，而不是运行时悄悄换协议。
 */

export interface GatewayLimits {
  maxBodyBytes: number;
  /** 单次请求 input 项数上限（message / function_call / function_call_output） */
  maxInputItems: number;
  /** 单个文本块 / instructions / 工具输出 / 工具参数的字符上限 */
  maxInputChars: number;
  maxOutputTokens: number;
  defaultMaxOutputTokens: number;
  upstreamTimeoutMs: number;
  /** 流式响应期间轮询撤权/成员状态的间隔 */
  revokePollMs: number;
  /** 单个上游 SSE 事件的字节上限（有界帧解析） */
  maxSseEventBytes: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  upstream: {
    /** 上游 **Responses** 完整 URL，例如 https://api.deepseek.com/v1/responses */
    url: string;
    /** 部署指定的上游模型名（客户端只能请求这个名字或 allowlist 内的名字） */
    model: string;
    /** 缺失时 = 未配置，请求返回 503 */
    apiKey?: string;
  };
  modelAllowlist: readonly string[];
  limits: GatewayLimits;
  /** 服务端 cell 凭据 → (tenantId, cellId) 的绑定表；生产由 AuthorizerPort 的 store 提供 */
  credentialSource: "port" | "env";
  /** 仅 credentialSource="env" 时使用；生产禁用 */
  envCredentials: Readonly<Record<string, { tenantId: string; cellId: string }>>;
}

export interface GatewayConfigOverrides {
  limits?: Partial<GatewayLimits>;
}

/**
 * 未显式配置 `MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS`（env 与 `overrides.limits` 都没给）时的
 * **隐式**输出预算，也是它的上限：`min(该值, 生效硬上限)`。决策与事故背景见
 * `docs/adr/0031-output-budget-and-turn-outcomes.md`；这里只记契约：
 *
 * * 隐式默认**只被生效硬上限收窄、不会被它抬高**（硬上限调高时默认仍是 8192）；
 * * 生效硬上限 = `overrides.limits.maxOutputTokens ?? MYRIX_GATEWAY_MAX_OUTPUT_TOKENS`，
 *   即 override 优先，隐式默认必须在这上面推导；
 * * 显式默认（override 或 env）原样生效并优先于隐式默认；显式默认大于生效硬上限仍然
 *   拒绝（fail-closed），不静默压低；本值不是"无限预算"，请求值恒被硬上限校验。
 */
export const PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: 1_000_000,
  maxInputItems: 200,
  maxInputChars: 100_000,
  maxOutputTokens: 8192,
  defaultMaxOutputTokens: PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS,
  upstreamTimeoutMs: 120_000,
  revokePollMs: 5_000,
  maxSseEventBytes: 1024 * 1024,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`);
  return value;
}

/** 与 {@link parsePositiveInt} 同样的校验，但"未配置"返回 `undefined` 而不是回退默认值。 */
function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return parsePositiveInt(raw, name, DEFAULT_LIMITS.maxOutputTokens);
}

/**
 * 上游必须是 https；只有 loopback 的 http 允许（本地联调 / 冒烟）。
 *
 * 额外硬约束：路径必须以 **`/responses`** 结尾。仓库禁止 `chat/completions`，
 * 也不做"只给 base URL 就帮你补路径"的猜测（那会掩盖部署配置错误）。
 */
export function assertUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 不是合法 URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 必须是 https（仅 loopback 允许 http，用于本地联调）");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 不得携带用户名或密码；凭据只能通过专用密钥配置提供");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 不能带查询串或 fragment");
  }
  if (!url.pathname.endsWith("/responses")) {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 必须是完整的 OpenAI Responses 端点（路径以 /responses 结尾）；网关不做路径补全，也不接受 chat/completions");
  }
  if (url.pathname.includes("chat/completions")) {
    throw new Error("MYRIX_GATEWAY_UPSTREAM_URL 不能指向 chat/completions：本仓库禁止该协议");
  }
  return url.toString();
}

export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: GatewayConfigOverrides = {},
): GatewayConfig {
  const upstreamUrl = env.MYRIX_GATEWAY_UPSTREAM_URL;
  if (upstreamUrl === undefined || upstreamUrl.trim() === "") {
    throw new Error("缺少 MYRIX_GATEWAY_UPSTREAM_URL：模型网关不提供默认上游");
  }
  const upstreamModel = env.MYRIX_GATEWAY_UPSTREAM_MODEL;
  if (upstreamModel === undefined || upstreamModel.trim() === "") {
    throw new Error("缺少 MYRIX_GATEWAY_UPSTREAM_MODEL：必须显式指定上游模型名");
  }

  const rawKey = env.MYRIX_GATEWAY_UPSTREAM_API_KEY;
  const apiKey = rawKey === undefined || rawKey.trim() === "" ? undefined : rawKey;

  const allowlist = (env.MYRIX_GATEWAY_MODEL_ALLOWLIST ?? upstreamModel)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (allowlist.length === 0) throw new Error("MYRIX_GATEWAY_MODEL_ALLOWLIST 不能为空");
  if (!allowlist.includes(upstreamModel)) {
    throw new Error("MYRIX_GATEWAY_MODEL_ALLOWLIST 必须包含 MYRIX_GATEWAY_UPSTREAM_MODEL");
  }

  const envMaxOutputTokens = parsePositiveInt(
    env.MYRIX_GATEWAY_MAX_OUTPUT_TOKENS,
    "MYRIX_GATEWAY_MAX_OUTPUT_TOKENS",
    DEFAULT_LIMITS.maxOutputTokens,
  );
  // 隐式默认必须在**生效**的硬上限上推导（override 优先于 env），否则 override 把硬上限
  // 调低时，先按 env 硬上限算出的 8192 默认值会与 override 硬上限冲突并被误判为非法配置。
  const effectiveMaxOutputTokens = overrides.limits?.maxOutputTokens ?? envMaxOutputTokens;
  const explicitDefault = parseOptionalPositiveInt(
    env.MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS,
    "MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS",
  );
  // 默认值优先级：override 显式默认 > env 显式默认 > 隐式默认 min(8192, 生效硬上限)。
  // 显式默认值大于生效硬上限仍然拒绝（fail-closed），不会被静默压低成硬上限。
  const defaultMaxOutputTokens = overrides.limits?.defaultMaxOutputTokens
    ?? explicitDefault
    ?? Math.min(PRACTICAL_DEFAULT_MAX_OUTPUT_TOKENS, effectiveMaxOutputTokens);

  const limits: GatewayLimits = {
    ...DEFAULT_LIMITS,
    maxBodyBytes: parsePositiveInt(env.MYRIX_GATEWAY_MAX_BODY_BYTES, "MYRIX_GATEWAY_MAX_BODY_BYTES", DEFAULT_LIMITS.maxBodyBytes),
    maxOutputTokens: envMaxOutputTokens,
    defaultMaxOutputTokens,
    upstreamTimeoutMs: parsePositiveInt(env.MYRIX_GATEWAY_UPSTREAM_TIMEOUT_MS, "MYRIX_GATEWAY_UPSTREAM_TIMEOUT_MS", DEFAULT_LIMITS.upstreamTimeoutMs),
    revokePollMs: parsePositiveInt(env.MYRIX_GATEWAY_REVOKE_POLL_MS, "MYRIX_GATEWAY_REVOKE_POLL_MS", DEFAULT_LIMITS.revokePollMs),
    ...overrides.limits,
  };
  if (limits.defaultMaxOutputTokens > limits.maxOutputTokens) {
    throw new Error("MYRIX_GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS 不能大于 MYRIX_GATEWAY_MAX_OUTPUT_TOKENS");
  }

  const credentialSource = (env.MYRIX_GATEWAY_CREDENTIAL_SOURCE ?? "port") === "env" ? "env" : "port";
  const envCredentials = credentialSource === "env" ? parseDevCredentials(env.MYRIX_GATEWAY_DEV_CREDENTIALS, env) : {};

  const config: GatewayConfig = {
    host: env.MYRIX_GATEWAY_HOST ?? "127.0.0.1",
    port: parsePositiveInt(env.MYRIX_GATEWAY_PORT ?? env.PORT, "MYRIX_GATEWAY_PORT", 8790),
    upstream: { url: assertUpstreamUrl(upstreamUrl), model: upstreamModel, ...(apiKey === undefined ? {} : { apiKey }) },
    modelAllowlist: allowlist,
    limits,
    credentialSource,
    envCredentials,
  };

  if (credentialSource === "env" && env.NODE_ENV === "production") {
    throw new Error("MYRIX_GATEWAY_CREDENTIAL_SOURCE=env 不允许在 production 使用：生产必须注入 AuthorizerPort");
  }
  if (credentialSource === "env" && config.envCredentials && Object.keys(config.envCredentials).length === 0) {
    throw new Error("MYRIX_GATEWAY_CREDENTIAL_SOURCE=env 但 MYRIX_GATEWAY_DEV_CREDENTIALS 为空");
  }
  return config;
}

/** 开发凭据表：{"<cell 服务令牌>": {"tenantId": "...", "cellId": "..."}} */
function parseDevCredentials(
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, { tenantId: string; cellId: string }> {
  if (raw === undefined || raw.trim() === "") {
    if (env.NODE_ENV === "production") throw new Error("production 下必须提供 AuthorizerPort，不能使用开发凭据表");
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MYRIX_GATEWAY_DEV_CREDENTIALS 必须是 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MYRIX_GATEWAY_DEV_CREDENTIALS 必须是 JSON 对象");
  }
  const result: Record<string, { tenantId: string; cellId: string }> = {};
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (token.length < 16) throw new Error("开发 cell 令牌至少 16 个字符，避免误配成弱口令");
    if (typeof value !== "object" || value === null) throw new Error(`开发凭据 ${token.slice(0, 4)}… 的绑定必须是对象`);
    const binding = value as { tenantId?: unknown; cellId?: unknown };
    if (typeof binding.tenantId !== "string" || typeof binding.cellId !== "string") {
      throw new Error("开发凭据必须包含 tenantId 与 cellId 字符串");
    }
    result[token] = { tenantId: binding.tenantId, cellId: binding.cellId };
  }
  return result;
}
