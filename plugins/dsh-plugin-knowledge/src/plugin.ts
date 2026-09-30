import type { MyrixContext } from "@myrix/dsh-shim";
import { KnowledgeGatewayClient } from "./gateway-client";

export const name = "myrix-knowledge";
export const inject = ["tools"];

export interface Config {
  controlPlaneUrl: string;
  token: string;
  principalId: string;
  tenantId: string;
  sessionId?: string;
  /** 工具名前缀，避免与企业既有 MCP 工具冲突 */
  toolPrefix?: string;
  timeoutMs?: number;
}

/**
 * 知识库接入 PEP（数据面）。
 *
 * 两条路线，本插件提供路线 A：
 * A. 平台工具（本文件）：注册 myrix_kb_search / myrix_kb_list_bases，逐调用带主体身份打
 *    Myrix 知识库网关 —— 身份天然是 per-user 的，适合"企业知识库有自己权限系统"的场景。
 * B. 标准 MCP：在 profile 里插入 @deepseek-ai/dsh-mcp-client 行，transport 用
 *    streamable-http 指向知识库自带的 MCP Server。优点是与 DSH 原生工具链一致；
 *    限制是 MCP 连接凭据是静态配置（DSH 0.2.0-rc.2 无 per-user 凭据注入），
 *    只适合"服务账号可读"或"知识库侧另有用户令牌兑换"的部署（见 ADR-0003）。
 */
export function apply(ctx: MyrixContext, config: Config): void {
  const prefix = config.toolPrefix ?? "myrix_";
  const client = new KnowledgeGatewayClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
    principal: {
      principalId: config.principalId,
      tenantId: config.tenantId,
      ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
    },
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });

  if (!ctx.tools.register) {
    ctx.logger?.warn(
      "myrix-knowledge: 当前 DSH 版本未暴露 ctx.tools.register 适配层，知识库工具未注册；" +
        "请改用 MCP 路线或按 docs/integration/dsh-seams.md 对齐注册 API",
    );
    return;
  }

  ctx.tools.register({
    name: prefix + "kb_search",
    description: "检索企业知识库（按当前用户权限过滤，返回可引用的片段）",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索问题" },
        top_k: { type: "number", description: "返回片段数，默认 5" },
      },
      required: ["query"],
    },
    run: async (args) => {
      const chunks = await client.search({
        text: String(args.query ?? ""),
        topK: typeof args.top_k === "number" ? args.top_k : 5,
      });
      return {
        content: chunks.map((chunk) => ({
          type: "text",
          text: chunk.text,
          citation: chunk.uri ?? chunk.baseId + "#" + chunk.id,
        })),
      };
    },
  });

  ctx.tools.register({
    name: prefix + "kb_list_bases",
    description: "列出当前用户有权访问的知识库目录",
    parameters: { type: "object", properties: {} },
    run: async () => await client.listBases(),
  });

  ctx.logger?.info("myrix-knowledge 已挂载", {
    controlPlaneUrl: config.controlPlaneUrl,
    principalId: config.principalId,
    tools: [prefix + "kb_search", prefix + "kb_list_bases"],
  });
}
