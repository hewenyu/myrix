/**
 * 小工具：id、摘要、常量时间比较。不引入第三方依赖。
 */
import { createHash, randomUUID } from "node:crypto";

/** 请求幂等键：允许客户端提供，但必须符合可打印 id 形状；否则服务端生成新 id。 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFrom(header: unknown): string {
  if (typeof header === "string" && REQUEST_ID_PATTERN.test(header)) return header;
  return randomUUID();
}

/** 凭据只以 SHA-256 摘要入库/查询，明文不落盘、不写日志。 */
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * 从 Authorization 头取 Bearer 令牌；格式不符返回 undefined。
 * 正则限定字符集与长度，避免把畸形头带进摘要查询（也顺带防止日志注入）。
 */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/-]{8,4096})$/.exec(header.trim());
  return match?.[1];
}
