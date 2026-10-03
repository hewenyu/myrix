import { getCsrfToken } from "./csrf";
import {
  CellUnavailableError,
  ConflictError,
  MyrixApiError,
  NetworkError,
  UnauthorizedError,
  parseApiErrorBody,
} from "./errors";
import { reportReachable, reportUnreachable } from "./transport";

/**
 * BFF 基地址。默认同源 `/api/v1`，因此浏览器按同源规则发送会话 cookie。
 * 允许通过 VITE_BFF_BASE 指向其它源，但不会因此添加任何自定义身份头。
 */
export const API_BASE = (import.meta.env.VITE_BFF_BASE ?? "/api/v1").replace(/\/$/, "");

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** 认证解析接口自身不触发 401 全局处理，避免死循环。 */
  allowUnauthorized?: boolean;
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 统一的 JSON 请求。凭据只靠同源 cookie；写请求带 CSRF token。
 * 不发送 actor/tenant 等身份字段——身份由服务端从会话推导。
 */
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });

  if (method !== "GET") {
    const token = getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    reportUnreachable("无法连接 Myrix BFF");
    throw new NetworkError(error);
  }

  reportReachable();
  const payload = await readBody(response);
  const apiError = parseApiErrorBody(payload);

  if (response.ok) return payload as T;

  if (response.status === 401) {
    if (options.allowUnauthorized) {
      throw new UnauthorizedError(apiError?.reason ?? "未认证");
    }
    throw new UnauthorizedError(apiError?.reason ?? undefined);
  }

  if (response.status === 409) {
    const conflict = payload as { status?: string; version?: number } | null;
    if (conflict && conflict.status === "conflict" && typeof conflict.version === "number") {
      throw new ConflictError({ status: "conflict", version: conflict.version });
    }
    throw new MyrixApiError(409, apiError?.error ?? "conflict", apiError?.reason ?? "版本冲突");
  }

  if (response.status === 503) {
    throw new CellUnavailableError(
      503,
      apiError?.error ?? "cell-unavailable",
      apiError?.reason ?? "运行会话的 cell 尚未就绪（可能正在唤醒）",
      parseRetryAfter(response),
    );
  }

  throw new MyrixApiError(
    response.status,
    apiError?.error ?? `http-${response.status}`,
    apiError?.reason ?? `请求失败（HTTP ${response.status}）`,
    parseRetryAfter(response),
  );
}

/**
 * SSE 连接。原生 EventSource 收到 401/403 只会静默重连，
 * 因此先用同源 fetch 探测 `GET /auth/session`，再建立事件流。
 */
export function openEventSource(path: string): EventSource {
  return new EventSource(`${API_BASE}${path}`, { withCredentials: true });
}
