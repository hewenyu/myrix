/**
 * `Authorization: Bearer <grant>` 的解析。
 *
 * 驱动只接受这一种携带方式；缺失、空、多个、scheme 不对一律 `grant/malformed`，
 * 不做“从 query/body 里找凭证”之类的兜底（那会扩大攻击面）。
 */
import { GrantError } from "./errors";

const BEARER_PREFIX = "bearer ";

export function parseBearerToken(headerValue: string | undefined | null): string {
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    throw new GrantError("grant/malformed", "缺少 Authorization 头");
  }
  if (headerValue.length > 9000) {
    throw new GrantError("grant/malformed", "Authorization 头超长");
  }
  const scheme = headerValue.slice(0, BEARER_PREFIX.length).toLowerCase();
  if (scheme !== BEARER_PREFIX) {
    throw new GrantError("grant/malformed", "Authorization scheme 必须是 Bearer");
  }
  const token = headerValue.slice(BEARER_PREFIX.length);
  if (token.length === 0) {
    throw new GrantError("grant/malformed", "Bearer 后没有凭证");
  }
  if (/\s/.test(token)) {
    throw new GrantError("grant/malformed", "凭证里不允许出现空白字符");
  }
  return token;
}
