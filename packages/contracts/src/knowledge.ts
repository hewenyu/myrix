import type { SubjectRef } from "./principal";

export interface KnowledgeBaseRef {
  id: string;
  tenantId: string;
  name: string;
  provider: string;
  description?: string;
  /** 该知识库所属的权限域，用于和知识库自身的 ACL 做联邦 */
  aclDomain?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeQuery {
  text: string;
  topK?: number;
  filters?: Record<string, unknown>;
}

export interface KnowledgeChunk {
  id: string;
  baseId: string;
  text: string;
  score: number;
  title?: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConnectorHealth {
  ok: boolean;
  detail?: string;
}

/**
 * 知识库连接器契约。
 *
 * 关键约定：subject 必须一路透传到知识库自身的权限系统，平台**不使用服务账号**代查。
 * 这样可以避免"平台侧一次授权 → 全库可读"的权限放大，也免去在 Myrix 里复制一份 ACL。
 * 平台只做：目录聚合、跨库路由、身份透传、结果合成与审计。
 */
export interface KnowledgeConnector {
  readonly id: string;
  readonly provider: string;
  listBases(subject: SubjectRef): Promise<KnowledgeBaseRef[]>;
  search(
    subject: SubjectRef,
    query: KnowledgeQuery & { baseIds: string[] },
  ): Promise<KnowledgeChunk[]>;
  health(): Promise<KnowledgeConnectorHealth>;
}
