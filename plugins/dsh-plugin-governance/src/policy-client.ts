import type { PolicyDecision } from "@myrix/contracts";

export interface PolicyClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** 判定结果缓存时长；策略热更新后最多滞后这么久 */
  cacheTtlMs?: number;
  /** @deprecated 仅保留旧配置兼容；网络/服务异常永远拒绝，false 不再允许 fail-open。 */
  failClosed?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DecideInput {
  principalId: string;
  action: string;
  resource: { type: string; id: string };
  context?: Record<string, unknown>;
}

export class PolicyClient {
  private readonly cache = new Map<string, { decision: PolicyDecision; expiresAt: number }>();

  constructor(private readonly options: PolicyClientOptions) {}

  async decide(input: DecideInput): Promise<PolicyDecision> {
    const now = this.options.now?.() ?? Date.now();
    const key = input.principalId + "|" + input.action + "|" + input.resource.type + ":" + input.resource.id;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.decision;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3000);
    try {
      const response = await fetchImpl(this.options.baseUrl.replace(/\/+$/, "") + "/api/v1/decisions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.options.token,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("PDP 返回 " + response.status.toString());
      const payload = (await response.json()) as { decision: PolicyDecision };
      const ttl = this.options.cacheTtlMs ?? 15_000;
      if (ttl > 0) this.cache.set(key, { decision: payload.decision, expiresAt: now + ttl });
      return payload.decision;
    } catch {
      // 治理平面不可用时默认拒绝：企业场景下"放行"的代价远高于"阻断"
      return {
        effect: "deny",
        matched: "default-deny",
        matchedRules: [],
        obligations: [],
        policyRevision: "unavailable",
        evaluatedAt: new Date(now).toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
