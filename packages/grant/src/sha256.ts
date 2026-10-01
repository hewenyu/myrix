/** 正文摘要：十六进制小写 SHA-256，作为 `bh` claim 的唯一规范形式。 */
import { createHash } from "node:crypto";

/** 计算 `bh`：小写十六进制 SHA-256。 */
export function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 十六进制 SHA-256 的严格形状：64 位小写十六进制。 */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}
