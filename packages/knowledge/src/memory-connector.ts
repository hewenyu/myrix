import type {
  KnowledgeBaseRef,
  KnowledgeChunk,
  KnowledgeConnector,
  KnowledgeConnectorHealth,
  KnowledgeQuery,
  SubjectRef,
} from "@myrix/contracts";

export interface MemoryDocument {
  id: string;
  text: string;
  score: number;
  title?: string;
  uri?: string;
  /** 可见组；为空表示租户内公开。用于模拟已有知识库自带的 ACL */
  visibleToGroups?: string[];
}

export interface MemoryBase {
  ref: KnowledgeBaseRef;
  documents: MemoryDocument[];
}

/**
 * 内存知识库连接器：用于本地开发、单测与管理后台演示。
 * 它刻意实现了"基于组可见性"的 ACL，用来说明平台如何与已有知识库权限体系共存：
 * 平台不复制 ACL，只透传身份，由连接器（真实场景是知识库自身的检索 API）裁决。
 */
export class MemoryKnowledgeConnector implements KnowledgeConnector {
  readonly id: string;
  readonly provider: string;
  private readonly bases: MemoryBase[];

  constructor(options: { id: string; provider?: string; bases: MemoryBase[] }) {
    this.id = options.id;
    this.provider = options.provider ?? "memory";
    this.bases = options.bases;
  }

  async listBases(subject: SubjectRef): Promise<KnowledgeBaseRef[]> {
    return this.bases
      .filter((base) => base.ref.tenantId === subject.tenantId)
      .filter((base) => {
        const groups = base.ref.metadata?.visibleToGroups;
        if (!Array.isArray(groups) || groups.length === 0) return true;
        return groups.some((group) => subjectGroups(subject).includes(String(group)));
      })
      .map((base) => base.ref);
  }

  async search(subject: SubjectRef, query: KnowledgeQuery & { baseIds: string[] }): Promise<KnowledgeChunk[]> {
    const groups = subjectGroups(subject);
    const needle = query.text.trim();
    const limit = query.topK ?? 8;
    const chunks: KnowledgeChunk[] = [];
    for (const base of this.bases) {
      if (!query.baseIds.includes(base.ref.id)) continue;
      if (base.ref.tenantId !== subject.tenantId) continue;
      const baseGroups = base.ref.metadata?.visibleToGroups;
      if (Array.isArray(baseGroups) && baseGroups.length > 0 && !baseGroups.some((group) => groups.includes(String(group)))) {
        continue;
      }
      for (const document of base.documents) {
        const docGroups = document.visibleToGroups;
        if (docGroups !== undefined && docGroups.length > 0 && !docGroups.some((group) => groups.includes(group))) {
          continue;
        }
        const hit = needle.length === 0 || document.text.includes(needle) || (document.title ?? "").includes(needle);
        if (!hit) continue;
        chunks.push({
          id: document.id,
          baseId: base.ref.id,
          text: document.text,
          score: document.score,
          ...(document.title === undefined ? {} : { title: document.title }),
          ...(document.uri === undefined ? {} : { uri: document.uri }),
        });
      }
    }
    return chunks.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  async health(): Promise<KnowledgeConnectorHealth> {
    return { ok: true, detail: this.bases.length + " bases in memory" };
  }
}

/** 主体组信息由 Myrix 注入到检索上下文的 metadata 中 */
function subjectGroups(subject: SubjectRef): string[] {
  const groups = (subject as SubjectRef & { groups?: string[] }).groups;
  return Array.isArray(groups) ? groups : [];
}
