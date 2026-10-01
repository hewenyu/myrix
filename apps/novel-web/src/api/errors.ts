import type { ApiError as WireApiError, SaveResult } from "@myrix/contracts";

/**
 * 所有错误都来自真实 HTTP 响应或网络故障，不做静默降级。
 * BFF 统一错误体为 `{ error, reason }`（见 docs/implementation/bff-api.md）。
 */
export class MyrixApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, reason: string, retryAfterSeconds: number | null = null) {
    super(reason || code);
    this.name = "MyrixApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 浏览器无法连接 BFF（网络中断、BFF 未启动、代理失败）。 */
export class NetworkError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("无法连接 Myrix BFF");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** 401：会话过期或被撤销。UI 必须回到登录态，不保留任何本地数据。 */
export class UnauthorizedError extends Error {
  constructor(reason = "身份会话无效或已过期") {
    super(reason);
    this.name = "UnauthorizedError";
  }
}

/**
 * 409：版本冲突。BFF 返回 `{ status: "conflict", version }`。
 * UI 必须保留本地草稿，允许重新读取与对比，绝不静默覆盖。
 */
export class ConflictError extends Error {
  readonly result: SaveResult;

  constructor(result: SaveResult) {
    super(`版本冲突，服务端当前版本为 ${result.version}`);
    this.name = "ConflictError";
    this.result = result;
  }
}

/**
 * 503：cell 尚未就绪或正在唤醒。BFF 在排队等待唤醒时返回该状态（标准 HTTP 语义）；
 * 客户端只依据状态码与标准 `Retry-After` 头，不发明自定义身份/状态头。
 */
export class CellUnavailableError extends MyrixApiError {}

export interface ErrorInfo {
  /** 展示给用户的分类，用于状态栏与重试提示。 */
  kind: "unauthorized" | "conflict" | "cell-unavailable" | "network" | "api";
  message: string;
  status?: number;
  retryAfterSeconds?: number;
}

export function describeError(error: unknown): ErrorInfo {
  if (error instanceof UnauthorizedError) return { kind: "unauthorized", message: error.message };
  if (error instanceof NetworkError) return { kind: "network", message: error.message };
  if (error instanceof ConflictError) return { kind: "conflict", message: error.message };
  if (error instanceof CellUnavailableError) {
    return {
      kind: "cell-unavailable",
      message: error.retryAfterSeconds
        ? `${error.reason}（服务端建议约 ${error.retryAfterSeconds} 秒后重试）`
        : error.reason,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds ?? undefined,
    };
  }
  if (error instanceof MyrixApiError) {
    return { kind: "api", message: error.reason || error.code, status: error.status };
  }
  if (error instanceof Error) return { kind: "api", message: error.message };
  return { kind: "api", message: "未知错误" };
}

export function parseApiErrorBody(body: unknown): WireApiError | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Partial<WireApiError>;
  if (typeof candidate.error !== "string") return null;
  return { error: candidate.error, reason: typeof candidate.reason === "string" ? candidate.reason : "" };
}
