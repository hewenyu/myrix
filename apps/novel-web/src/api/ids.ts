let counter = 0;

/**
 * 命令幂等键。使用 `crypto.randomUUID()`，不可用时退回随机十六进制。
 * 只用于重复提交去重，不承载任何身份或业务含义。
 */
export function newCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  counter += 1;
  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16).padStart(12, "0");
  return `${Date.now().toString(16)}-${counter.toString(16)}-${random}`;
}
