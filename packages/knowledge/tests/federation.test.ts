import { describe, expect, it } from "vitest";
import type { KnowledgeConnector, KnowledgeChunk, SubjectRef } from "@myrix/contracts";
import { KnowledgeFederation, MemoryKnowledgeConnector } from "../src/index";

function subject(principalId: string, groups: string[]): SubjectRef & { groups: string[] } {
  return { principalId, tenantId: "acme", groups, sessionId: "s_1" };
}

function knowledge(): KnowledgeFederation {
  const federation = new KnowledgeFederation();
  federation.register(
    new MemoryKnowledgeConnector({
      id: "kb-main",
      bases: [
        {
          ref: { id: "kb-handbook", tenantId: "acme", name: "员工手册", provider: "memory" },
          documents: [{ id: "d1", text: "年假规则：入职满一年 10 天", score: 0.9, title: "年假" }],
        },
        {
          ref: {
            id: "kb-finance",
            tenantId: "acme",
            name: "财务底稿",
            provider: "memory",
            metadata: { visibleToGroups: ["dept:finance"] },
          },
          documents: [{ id: "f1", text: "Q3 收入 1.2 亿", score: 0.95, title: "Q3" }],
        },
      ],
    }),
  );
  return federation;
}

describe("KnowledgeFederation", () => {
  it("按主体可见性聚合目录（权限联邦，不放大）", async () => {
    const federation = knowledge();
    const engineer = await federation.listBases(subject("u_1", ["dept:engineering"]));
    const finance = await federation.listBases(subject("u_2", ["dept:finance"]));
    expect(engineer.bases.map((base) => base.id)).toEqual(["kb-handbook"]);
    expect(finance.bases.map((base) => base.id)).toEqual(["kb-finance", "kb-handbook"]);
  });

  it("显式请求不可见知识库时被收窄，而不是放行", async () => {
    const federation = knowledge();
    const result = await federation.search(subject("u_1", ["dept:engineering"]), { text: "" }, {
      baseIds: ["kb-finance", "kb-handbook"],
    });
    expect(result.searchedBases).toEqual(["kb-handbook"]);
    expect(result.chunks.every((chunk) => chunk.baseId === "kb-handbook")).toBe(true);
  });

  it("跨库结果按分数合并并截断", async () => {
    const federation = knowledge();
    const result = await federation.search(subject("u_2", ["dept:finance"]), { text: "" }, { topK: 1 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.baseId).toBe("kb-finance");
  });

  it("单个连接器故障不影响其他连接器", async () => {
    const federation = knowledge();
    const broken: KnowledgeConnector = {
      id: "broken",
      provider: "broken",
      listBases: async () => {
        throw new Error("connection refused");
      },
      search: async (): Promise<KnowledgeChunk[]> => [],
      health: async () => ({ ok: false }),
    };
    federation.register(broken);
    const result = await federation.search(subject("u_1", ["dept:engineering"]), { text: "年假" });
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["d1"]);
    expect(result.errors).toEqual([{ connectorId: "broken", message: "connection refused" }]);
  });
});
