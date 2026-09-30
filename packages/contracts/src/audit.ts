import type { Obligation } from "./policy";

/**
 * 审计事件契约。
 *
 * 分层约定：模型调用、Token 用量、提示词/响应内容级审计由 **LLM 网关**产生；
 * Myrix 只产生"治理决策"与"工具执行"两类事件，并通过 traceId 与网关日志关联。
 * 两边通过同一套 trace 字段（tenantId/principalId/sessionId/toolCallId）串联。
 */
export interface AuditEvent {
  id: string;
  ts: string;
  tenantId: string;
  principalId: string;
  sessionId?: string;
  /** 关联的 LLM 网关 trace，便于把模型侧审计拉回来 */
  traceId?: string;
  category: "policy-decision" | "tool-execution" | "knowledge-access" | "admin-change";
  action: string;
  resource: string;
  effect: "allow" | "deny";
  matchedRules?: string[];
  obligations?: Obligation[];
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}
