import type { KnowledgeBaseRef, KnowledgeChunk } from "@myrix/contracts";

export interface KnowledgeGatewayOptions {
  baseUrl: string;
  token: string;
  /** 主体身份：必须逐调用透传，平台不使用服务账号代查 */
  principal: { principalId: string; tenantId: string; sessionId?: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SearchInput {
  text: string;
  topK?: number;
  baseIds?: string[];
}

/**
 * Myrix 知识库网关客户端。
 *
 * 刻意做成"平台侧网关"而不是直连企业知识库：网关统一做目录聚合、跨库路由、
 * 身份透传与审计；企业知识库的 ACL 仍是最终裁决者（见 ADR-0003）。
 */
export class KnowledgeGatewayClient {
  constructor(private readonly options: KnowledgeGatewayOptions) {}

  async listBases(): Promise<{ bases: KnowledgeBaseRef[]; errors: { connectorId: string; message: string }[] }> {
    const response = await this.request(
      "/api/v1/knowledge/bases?principalId=" + encodeURIComponent(this.options.principal.principalId),
      undefined,
    );
    return (await response.json()) as { bases: KnowledgeBaseRef[]; errors: { connectorId: string; message: string }[] };
  }

  async search(input: SearchInput): Promise<KnowledgeChunk[]> {
    const response = await this.request(
      "/api/v1/knowledge/search",
      JSON.stringify({
        principalId: this.options.principal.principalId,
        text: input.text,
        topK: input.topK ?? 5,
        ...(input.baseIds === undefined ? {} : { baseIds: input.baseIds }),
      }),
    );
    const payload = (await response.json()) as { chunks: KnowledgeChunk[] };
    return payload.chunks;
  }

  private async request(path: string, body: string | undefined): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await fetchImpl(this.options.baseUrl.replace(/\/+$/, "") + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.options.token,
          "x-myrix-principal": this.options.principal.principalId,
          "x-myrix-tenant": this.options.principal.tenantId,
          ...(this.options.principal.sessionId === undefined
            ? {}
            : { "x-myrix-session": this.options.principal.sessionId }),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("知识库网关返回 " + response.status.toString());
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}
