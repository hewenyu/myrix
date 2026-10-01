/**
 * 平台存储错误：所有可预期的失败都用带 code + reason 的结构化错误表达。
 *
 * `reason` 是给人看的原因字符串（仓库硬性规则 3：允许/拒绝都必须能说清"为什么"），
 * 也是 HTTP 边界 `{ error, reason }` 里 reason 的来源。
 */

export type PlatformErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "version_conflict"
  | "duplicate_request"
  | "revoked"
  | "queue_exhausted"
  | "unsupported_operation"
  | "storage_unavailable"
  | "internal";

const HTTP_STATUS: Record<PlatformErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  duplicate_request: 409,
  revoked: 410,
  queue_exhausted: 409,
  unsupported_operation: 400,
  storage_unavailable: 503,
  internal: 500,
};

export interface PlatformErrorInit {
  code: PlatformErrorCode;
  reason: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class PlatformStoreError extends Error {
  readonly code: PlatformErrorCode;
  readonly reason: string;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(init: PlatformErrorInit) {
    super(`${init.code}: ${init.reason}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "PlatformStoreError";
    this.code = init.code;
    this.reason = init.reason;
    this.details = init.details ?? {};
    this.httpStatus = HTTP_STATUS[init.code];
  }

  /**
   * HTTP 边界统一序列化：只暴露 error + reason。
   *
   * `reason` 必须是调用方自己写好的可读原因，**绝不能**塞 SQL 原文、连接串、
   * 作品正文或数据库内部报错（审计/日志才保留 cause）。
   */
  toResponseBody(): { error: PlatformErrorCode; reason: string } {
    return { error: this.code, reason: this.reason };
  }
}

export function isPlatformStoreError(value: unknown): value is PlatformStoreError {
  return value instanceof PlatformStoreError;
}

export const errors = {
  invalidInput(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "invalid_input", reason, details });
  },
  forbidden(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "forbidden", reason, details });
  },
  notFound(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "not_found", reason, details });
  },
  conflict(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "conflict", reason, details });
  },
  versionConflict(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "version_conflict", reason, details });
  },
  duplicateRequest(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "duplicate_request", reason, details });
  },
  revoked(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "revoked", reason, details });
  },
  queueExhausted(reason: string, details?: Record<string, unknown>): PlatformStoreError {
    return new PlatformStoreError({ code: "queue_exhausted", reason, details });
  },
  storageUnavailable(reason: string, cause?: unknown): PlatformStoreError {
    return new PlatformStoreError({ code: "storage_unavailable", reason, cause });
  },
  /**
   * 内部错误：调用方已知的错误（版本冲突等）之外的失败。
   * reason 只写"服务端内部错误 + 操作名"，**不带**原始 message，
   * 避免 SQL 片段/正文通过 HTTP 泄漏；原始错误放 cause 供服务端日志。
   */
  internal(reason: string, cause?: unknown): PlatformStoreError {
    return new PlatformStoreError({ code: "internal", reason, cause });
  },
};
