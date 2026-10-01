/**
 * HTTP 边界：OpenAI **Responses** `/v1/responses`（流式与非流式）。
 *
 * 只做传输层的事：正文上限、头解析、把客户端断线转成 AbortSignal、把
 * `ModelGateway` 的结果写成 HTTP。所有判定与计量都在 gateway.ts 里，便于单测。
 *
 * **不存在 chat/completions**：该路径没有注册任何路由（Fastify 404），也没有
 * 兼容层、隐式转换或失败回退（AGENTS.md 硬性规则 6）。notFound 处理器显式说明
 * 这一点，避免客户端把 404 误读成"临时故障"而重试旧协议。
 *
 * 客户端请求头里**只有三个**参与：
 *   * `Authorization: Bearer <cell 服务令牌>`（服务端凭据）
 *   * `x-myrix-session`（会话归因）
 *   * `x-myrix-revision`（撤权版本 rev）
 * 其余 `x-myrix-tenant` / `x-myrix-cell-tenant` / `x-myrix-purpose` / `x-myrix-user`
 * 之类的归因/诊断头一律忽略（网关只信凭据与数据库绑定）。
 */
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { GatewayError } from "./errors";
import type { GatewayResponse, ResponseGatewayInput } from "./gateway";
import { ModelGateway } from "./gateway";
import { requestIdFrom } from "./util";

export interface ModelGatewayServerOptions {
  gateway: ModelGateway;
  bodyLimitBytes: number;
  /** 测试可开启 fastify logger；默认关闭，避免把凭据/正文写进日志 */
  logger?: boolean;
}

const UPSTREAM_HEADER = "authorization";
const SESSION_HEADER = "x-myrix-session";
const REVISION_HEADER = "x-myrix-revision";
const REQUEST_ID_HEADER = "x-request-id";

function headerValue(request: { headers: Record<string, unknown> }, name: string): unknown {
  return request.headers[name];
}

export async function createModelGatewayServer(options: ModelGatewayServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: false,
    bodyLimit: options.bodyLimitBytes,
    requestTimeout: 0,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof GatewayError) return reply.code(error.statusCode).send(error.toWire());
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status === 413) {
      return reply.code(413).send({
        error: { message: `请求正文超过上限 ${options.bodyLimitBytes} 字节`, type: "invalid_request_error", code: "payload_too_large" },
      });
    }
    if (error.validation || status === 400) {
      return reply.code(400).send({ error: { message: "请求体不是合法的 JSON 对象", type: "invalid_request_error", code: "invalid_request_error" } });
    }
    // 不把内部错误详情回给客户端（可能含上游 URL 等部署信息）。
    return reply.code(status >= 400 && status < 500 ? status : 500).send({
      error: { message: "模型网关内部错误", type: "service_unavailable", code: "internal_error" },
    });
  });

  // 未注册的路径（尤其 legacy /v1/chat/completions）明确 404：本网关不提供该协议，
  // 也不做兼容转换，客户端必须迁移到 /v1/responses。
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        message: `模型网关不提供 ${request.method} ${request.url}；请使用 OpenAI Responses 的 POST /v1/responses（本仓库禁止 chat/completions，不保留兼容入口）`,
        type: "not_found_error",
        code: "not_found",
      },
    }),
  );

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const readiness = options.gateway.readiness();
    return reply.code(readiness.ready ? 200 : 503).send(readiness);
  });
  /** 允许清单是公开信息（便于客户端发现可用模型），上游地址与密钥不暴露。 */
  app.get("/v1/models", async () => ({
    object: "list",
    data: options.gateway.allowlist.entries.map((id) => ({ id, object: "model", owned_by: "myrix" })),
  }));

  app.post("/v1/responses", async (request, reply) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("myrix: client closed"));
    // 客户端在请求体还没发完就断开 → 立刻取消（此时可能还没开始调用上游）。
    // 注意：**不能**监听 request.raw 的 'close' —— 请求体正常读完时它也会触发，
    // 那会把每一次正常调用都误判成断线。流式传输中的断线在下面按响应侧判断。
    request.raw.once("aborted", abort);

    const input: ResponseGatewayInput = {
      authorization: headerValue(request, UPSTREAM_HEADER),
      sessionId: headerValue(request, SESSION_HEADER),
      revision: headerValue(request, REVISION_HEADER),
      requestId: requestIdFrom(headerValue(request, REQUEST_ID_HEADER)),
      body: request.body,
      clientSignal: controller.signal,
    };

    let result: GatewayResponse;
    try {
      result = await options.gateway.handleResponse(input);
    } finally {
      request.raw.off("aborted", abort);
    }

    if (result.kind === "error" || result.kind === "json") {
      request.raw.off("aborted", abort);
      return reply.code(result.status).send(result.body);
    }

    // SSE：接管响应，逐块写回。
    reply.hijack();
    const raw = reply.raw;
    // 响应侧 'close' 且尚未 end() = 客户端在读流期间挂断 → 取消上游，不继续烧额度。
    raw.once("close", () => {
      if (!raw.writableEnded) abort();
    });
    raw.writeHead(result.status, { ...result.headers });
    try {
      for await (const chunk of result.stream) {
        if (raw.writableEnded || raw.destroyed) break;
        raw.write(chunk);
      }
      if (!raw.writableEnded) raw.end();
    } catch {
      if (!raw.writableEnded) raw.end();
    } finally {
      request.raw.off("aborted", abort);
    }
    return reply;
  });

  return app;
}
