import type {
  KnowledgeBaseRef,
  KnowledgeChunk,
  KnowledgeConnector,
  KnowledgeQuery,
  SubjectRef,
} from "@myrix/contracts";

export interface FederatedSearchResult {
  chunks: KnowledgeChunk[];
  searchedBases: string[];
  errors: { connectorId: string; message: string }[];
}

export interface FederatedSearchOptions {
  /** 期望检索的知识库；会被"该主体可见"这一集合求交，永远不会放宽权限 */
  baseIds?: string[];
  connectorIds?: string[];
  topK?: number;
}

/**
 * 知识库联邦。
 *
 * 三条铁律：
 * 1) 只做"收窄"：请求的 baseIds 与主体可见集合求交，平台不会替用户越权检索；
 * 2) 身份透传：subject 原样传给 Connector，由知识库自己的 ACL 做最终裁决，
 *    因此企业已有知识库的权限体系不需要重建，也不会被服务账号绕过；
 * 3) 故障隔离：单个 Connector 失败只影响它自己的结果，其余照常返回。
 */
export class KnowledgeFederation {
  private readonly connectors = new Map<string, KnowledgeConnector>();

  register(connector: KnowledgeConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error("知识库连接器 id 重复：" + connector.id);
    }
    this.connectors.set(connector.id, connector);
  }

  list(): KnowledgeConnector[] {
    return [...this.connectors.values()];
  }

  async listBases(subject: SubjectRef): Promise<{ bases: KnowledgeBaseRef[]; errors: { connectorId: string; message: string }[] }> {
    const errors: { connectorId: string; message: string }[] = [];
    const settled = await Promise.allSettled(
      this.list().map(async (connector) => ({ connectorId: connector.id, bases: await connector.listBases(subject) })),
    );
    const bases: KnowledgeBaseRef[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        bases.push(...result.value.bases);
        continue;
      }
      const connector = this.list()[index];
      errors.push({
        connectorId: connector?.id ?? "unknown",
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
    return { bases: bases.sort((left, right) => left.id.localeCompare(right.id)), errors };
  }

  async search(
    subject: SubjectRef,
    query: KnowledgeQuery,
    options: FederatedSearchOptions = {},
  ): Promise<FederatedSearchResult> {
    const errors: { connectorId: string; message: string }[] = [];
    const visible = await this.listBases(subject);
    errors.push(...visible.errors);
    const visibleIds = new Set(visible.bases.map((base) => base.id));
    const requested = options.baseIds === undefined
      ? [...visibleIds]
      : options.baseIds.filter((id) => visibleIds.has(id));
    const connectorFilter = options.connectorIds === undefined ? undefined : new Set(options.connectorIds);

    const byConnector = new Map<string, string[]>();
    for (const base of visible.bases) {
      if (!requested.includes(base.id)) continue;
      const providerConnector = visible.bases.find((item) => item.id === base.id)?.provider ?? "";
      const connectorId = [...this.connectors.values()].find(
        (connector) => connector.provider === providerConnector && (connectorFilter === undefined || connectorFilter.has(connector.id)),
      )?.id;
      if (connectorId === undefined) continue;
      const bucket = byConnector.get(connectorId) ?? [];
      bucket.push(base.id);
      byConnector.set(connectorId, bucket);
    }

    const settled = await Promise.allSettled(
      [...byConnector.entries()].map(async ([connectorId, baseIds]) => {
        const connector = this.connectors.get(connectorId);
        if (!connector) return [] as KnowledgeChunk[];
        return connector.search(subject, { ...query, baseIds });
      }),
    );

    const chunks: KnowledgeChunk[] = [];
    const connectorIds = [...byConnector.keys()];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        chunks.push(...result.value);
        continue;
      }
      errors.push({
        connectorId: connectorIds[index] ?? "unknown",
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }

    const seen = new Set<string>();
    const merged = chunks
      .filter((chunk) => {
        const key = chunk.baseId + "/" + chunk.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK ?? 8);

    return { chunks: merged, searchedBases: requested, errors };
  }
}
