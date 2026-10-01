/**
 * compact JWS（RFC 7515）编解码，只保留 ES256 需要的最小面。
 *
 * 任何解析失败都必须落到 `grant/malformed`，不允许出现“解析出来一半就继续验”的路径。
 */
import { GrantError } from "./errors";

export interface JwsHeader {
  alg: string;
  kid: string;
  typ: string;
}

export interface DecodedJws {
  /** header 与 payload 的原始 base64url 文本，验签时按原样拼回去。 */
  signingInput: string;
  header: JwsHeader;
  payload: Uint8Array;
  signature: Uint8Array;
}

/** compact JWS 的硬上限：正常凭证 < 2KB，超长一律当畸形拒绝，避免放大器。 */
export const MAX_TOKEN_LENGTH = 8 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeBase64UrlStrict(segment: string, what: string): Uint8Array {
  if (segment.length === 0) throw new GrantError("grant/malformed", `${what}：base64url 段为空`);
  if (!BASE64URL_PATTERN.test(segment)) {
    throw new GrantError("grant/malformed", `${what}：base64url 段含非法字符`, { segmentLength: segment.length });
  }
  if (segment.length % 4 === 1) {
    throw new GrantError("grant/malformed", `${what}：base64url 段长度非法`);
  }
  const bytes = Buffer.from(segment, "base64url");
  // 逐字节回编码比对，挡掉“非规范编码”带来的同一 token 多种写法（二次签名/重放面）。
  if (bytes.toString("base64url") !== segment) {
    throw new GrantError("grant/malformed", `${what}：base64url 编码不规范`);
  }
  return bytes;
}

function decodeJsonObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GrantError("grant/malformed", `${what} 不是合法 UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GrantError("grant/malformed", `${what} 不是合法 JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GrantError("grant/malformed", `${what} 不是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(segment: string): Uint8Array {
  return decodeBase64UrlStrict(segment, "token");
}

/** 签发：header/payload 由调用方给 JSON 文本，签名输入按原字节拼接。 */
export function buildSigningInput(headerJson: unknown, payloadJson: unknown): string {
  const headerBytes = Buffer.from(JSON.stringify(headerJson), "utf8");
  const payloadBytes = Buffer.from(JSON.stringify(payloadJson), "utf8");
  return `${headerBytes.toString("base64url")}.${payloadBytes.toString("base64url")}`;
}

/** 校验：解出 header、payload 与签名，并保留原始签名输入。 */
export function decodeJwsCompact(token: string): DecodedJws {
  if (typeof token !== "string" || token.length === 0) {
    throw new GrantError("grant/malformed", "token 为空或不是字符串");
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new GrantError("grant/malformed", "token 超出长度上限", { length: token.length, max: MAX_TOKEN_LENGTH });
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new GrantError("grant/malformed", "token 不是三段式 compact JWS", { segments: parts.length });
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  const header = decodeJsonObject(decodeBase64UrlStrict(headerSegment, "header"), "header");
  const payload = decodeBase64UrlStrict(payloadSegment, "payload");
  const signature = decodeBase64UrlStrict(signatureSegment, "signature");

  const alg = header["alg"];
  const kid = header["kid"];
  return {
    signingInput: `${headerSegment}.${payloadSegment}`,
    header: {
      alg: typeof alg === "string" ? alg : "",
      kid: typeof kid === "string" ? kid : "",
      typ: typeof header["typ"] === "string" ? (header["typ"] as string) : "",
    },
    payload,
    signature,
  };
}

/** payload 解析成对象；在签名校验通过后才会被调用。 */
export function decodePayloadObject(payload: Uint8Array): Record<string, unknown> {
  return decodeJsonObject(payload, "payload");
}
