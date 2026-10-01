import { parseToolArguments, type NovelToolName } from "./protocol";

export interface NovelPrincipal { sessionId: string; revision: number }
export interface NovelStoreOptions {
  origin: string;
  credential: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof fetch;
}

/** Internal service client. The browser/model never supplies identity, tenant, work, URL or credentials. */
export class NovelStoreClient {
  private readonly origin: string;
  constructor(private readonly options: NovelStoreOptions) {
    const url = new URL(options.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("作品服务地址必须为明确的 HTTP(S) origin");
    if (!options.credential || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000 || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1024 || options.maxResponseBytes > 8_000_000) throw new Error("作品服务凭据或请求限制未正确配置");
    this.origin = url.origin;
  }
  async call(principal: NovelPrincipal, tool: NovelToolName, input: unknown, signal: AbortSignal): Promise<string> {
    const args = parseToolArguments(tool, input);
    if (!principal.sessionId || !Number.isSafeInteger(principal.revision) || principal.revision < 0) throw new Error("会话身份缺失或已失效");
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
    const response = await (this.options.fetch ?? fetch)(`${this.origin}/internal/v1/sessions/${encodeURIComponent(principal.sessionId)}/tools/${tool}`, {
      method: "POST", redirect: "error", signal: combined,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.credential}`, "x-myrix-revision": String(principal.revision) },
      body: JSON.stringify(args),
    });
    if (!response.ok && response.status !== 409) {
      await response.body?.cancel();
      throw new Error(response.status === 403 || response.status === 401 ? "会话、成员或作品访问权限已失效" : "作品服务暂不可用；请先读取当前版本再决定是否重试写入");
    }
    if (!response.body) throw new Error("作品服务没有返回结果");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.options.maxResponseBytes) throw new Error("作品内容超过本次工具读取上限，请缩小检索范围");
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("result" in parsed)) throw new Error("作品服务返回格式不正确");
    return JSON.stringify(parsed.result);
  }
}
