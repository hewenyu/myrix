import { PolicyClient, describeError } from "./policy-client";
import { defaultPresetMapping, presetForMode, toPreExecuteResult, toToolGate } from "./obligation-mapping";
import type { MyrixContext, PreExecuteResult } from "@myrix/dsh-shim";

export const name = "myrix-governance";
export const inject = ["tools"];

export interface Config {
  /** Myrix 控制面地址，例如 http://127.0.0.1:8787 */
  controlPlaneUrl: string;
  /** 数据面令牌：只允许调用判定/审计接口 */
  token: string;
  /**
   * 当前主体。v1 由 profile 渲染时注入（每主体一个 Harness home / profile）；
   * 多用户共进程场景必须在 Connection 层派生 peer 后再注入，见 ADR-0002。
   */
  principalId: string;
  sessionId?: string;
  failClosed?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
  presetMapping?: Record<"read-only" | "workspace-write" | "danger-full-access", string>;
}

/**
 * 治理 PEP：
 * 1) tools/pre-execute — 取判定结果，deny / ask / allow 三态；
 *    allow 时若带 sandbox 义务，则切换该 session 的 permission preset。
 * 2) ctx.tools.guard — 单调兜底：即使 pre-execute 被别的接线绕过，
 *    被拒的工具依旧无法执行（guard 只能收紧，不能放宽）。
 */
export function apply(ctx: MyrixContext, config: Config): void {
  const client = new PolicyClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.cacheTtlMs === undefined ? {} : { cacheTtlMs: config.cacheTtlMs }),
    ...(config.failClosed === undefined ? {} : { failClosed: config.failClosed }),
  });
  const presetMapping = config.presetMapping ?? defaultPresetMapping();

  ctx.on("tools/pre-execute", async (call): Promise<PreExecuteResult> => {
    const decision = await client.decide({
      principalId: config.principalId,
      action: "tool:" + call.toolName,
      resource: { type: "tool", id: call.toolName },
      context: {
        sessionId: call.sessionId ?? config.sessionId,
        agentId: call.agentId,
      },
    });
    const gate = toToolGate(decision);
    if (gate.kind === "allow" && gate.sandboxMode !== undefined) {
      const sessionId = call.sessionId ?? config.sessionId;
      if (sessionId !== undefined && ctx.permissionPresets) {
        const preset = presetForMode(gate.sandboxMode, presetMapping);
        ctx.permissionPresets.set(sessionId, preset);
        ctx.logger?.info("myrix: 已收紧沙箱 preset", { sessionId, preset });
      }
    }
    return toPreExecuteResult(gate);
  });

  ctx.tools.guard(async (call) => {
    const decision = await client.decide({
      principalId: config.principalId,
      action: "tool:" + call.toolName,
      resource: { type: "tool", id: call.toolName },
      context: { sessionId: call.sessionId ?? config.sessionId, agentId: call.agentId },
    });
    if (decision.effect === "allow") return undefined;
    return "Myrix 策略拒绝：" + (decision.matchedRules.join(",") || "default-deny");
  });

  ctx.logger?.info("myrix-governance 已挂载", {
    controlPlaneUrl: config.controlPlaneUrl,
    principalId: config.principalId,
    errorHelper: describeError(new Error("ok")),
  });
}
