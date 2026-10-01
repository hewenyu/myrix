/**
 * 网关错误：统一 HTTP 状态码 + OpenAI 兼容错误体。
 *
 * 硬性规则（AGENTS.md 1）：默认 fail-closed。所有"拒绝"都必须带上可读原因，
 * 原因字符串里**不得包含**上行密钥、请求正文或上游原始响应体。
 */
export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "service_unavailable"
  | "upstream_error";

export interface GatewayWireError {
  error: { message: string; type: GatewayErrorType; code: string };
}

export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly reason: string,
    readonly type: GatewayErrorType = "invalid_request_error",
  ) {
    super(reason);
    this.name = "GatewayError";
  }

  /** 只暴露 code/type/message；调用方不得把上游原始响应或密钥塞进 reason。 */
  toWire(): GatewayWireError {
    return { error: { message: this.reason, type: this.type, code: this.code } };
  }
}

export const invalidRequest = (reason: string): GatewayError =>
  new GatewayError(400, "invalid_request_error", reason, "invalid_request_error");

export const unauthorized = (reason: string): GatewayError =>
  new GatewayError(401, "invalid_api_key", reason, "authentication_error");

export const forbidden = (reason: string): GatewayError =>
  new GatewayError(403, "forbidden", reason, "permission_error");

export const modelNotAllowed = (model: string): GatewayError =>
  new GatewayError(
    403,
    "model_not_allowed",
    `模型 ${model} 不在本网关的允许清单内（allowlist 由部署配置，客户端不能自行扩展）`,
    "permission_error",
  );

export const payloadTooLarge = (limit: number): GatewayError =>
  new GatewayError(413, "payload_too_large", `请求正文超过上限 ${limit} 字节`, "invalid_request_error");

export const quotaExceeded = (reason: string): GatewayError =>
  new GatewayError(429, "insufficient_quota", reason, "insufficient_quota");

export const notConfigured = (reason: string): GatewayError =>
  new GatewayError(503, "model_not_configured", reason, "service_unavailable");

export const upstreamFailed = (status: number, reason: string): GatewayError =>
  new GatewayError(status, "upstream_error", reason, "upstream_error");

export const upstreamTimeout = (timeoutMs: number): GatewayError =>
  new GatewayError(504, "upstream_timeout", `上游模型在 ${timeoutMs}ms 内未完成响应`, "upstream_error");

export const clientAborted = (): GatewayError =>
  new GatewayError(499, "client_closed_request", "客户端已断开连接", "invalid_request_error");

/** 判断任意抛错是否是客户端主动取消（AbortController.abort 的默认 reason）。 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
