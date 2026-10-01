/**
 * CSRF token 的唯一存放点。
 *
 * Token 只来自 BFF 的 `GET /auth/session` 响应体（见 docs/implementation/bff-api.md），
 * 不写入 localStorage，也不由前端生成或猜测。写请求统一带 `X-CSRF-Token`。
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = typeof token === "string" && token.length > 0 ? token : null;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}
