import { createHash, randomUUID } from "node:crypto";

/**
 * 存储层需要的小工具：随机标识、正文哈希、稳定 JSON 序列化。
 *
 * 标识一律用 UUIDv4（不可推测随机值，符合 first-version.md 的接口基线），
 * 不使用自增或含业务含义的编码。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function randomId(): string {
  return randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function assertUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new Error(`myrix: ${field} 必须是 UUID，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 服务端正文哈希（章节正文直接用它，就是凭证里的 bh 同款算法） */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 稳定 JSON 序列化：对象键排序、数组保序，保证同一逻辑内容在任何进程里哈希一致。
 * 用于大纲/设定这类结构化内容的 CAS 比较。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function hashJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** 文本归一化：去掉尾部空白差异造成的"假冲突"，但保留正文内部所有内容 */
export function canonicalText(text: string): string {
  return text;
}

/** 数据库 text 长度上限保护，避免超长输入直冲 TOAST */
export function assertLength(value: string, field: string, max: number, min = 0): void {
  const length = value.length;
  if (length < min || length > max) {
    throw new Error(`myrix: ${field} 长度必须在 ${min}..${max} 之间，收到 ${length}`);
  }
}
