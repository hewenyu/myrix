/**
 * HTTP 边界：OpenAI **Responses** `/v1/responses`（流式与非流式）。
 *
 * 只做传输层的事：正文上限、头解析、把客户端断线转成 AbortSignal、把
 * `ModelGateway` 的结果写成 HTTP。所有判定与计量都在 gateway.ts 里，便于单测。
 *
 * 流式取消有两条来源，必须都接到写出层：客户端断线（本层 `controller`）与 gateway
 * 内部的 timeout/撤权（`GatewayResponse.signal`）。只接前者时，慢消费者把写循环挂在
 * drain 上，内部超时唤不醒它 → 迭代器 finally 不结算、响应不 end()，永久挂死。
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
import { createSseWriter } from "./stream";
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

    // 客户端可能在 `handleResponse` 等待上游响应头期间就挂断（此时还没写任何一行）。
    // 请求侧 `'aborted'` 只在**请求体没读完**时触发：正文读完后的断线不触发它（实测），
    // 所以唯一可靠的信号是响应侧 `'close'` —— 必须**提前**挂上，否则 writer 要等
    // handleResponse 返回后才监听，会漏掉这次断线（流继续拉、额度继续烧）。
    const onClientClose = (): void => {
      if (!reply.raw.writableEnded) abort();
    };
    reply.raw.once("close", onClientClose);

    let result: GatewayResponse;
    try {
      result = await options.gateway.handleResponse(input);
    } catch (error) {
      reply.raw.off("close", onClientClose);
      request.raw.off("aborted", abort);
      throw error;
    }
    request.raw.off("aborted", abort);

    if (result.kind === "error" || result.kind === "json") {
      reply.raw.off("close", onClientClose);
      return reply.code(result.status).send(result.body);
    }

    // SSE：接管响应，逐块写回。
    //
    // 背压：`raw.write()` 返回 false 表示内核写缓冲已满（消费者读得比上游慢）。
    // 旧实现直接忽略返回值，于是一个不读响应的客户端能让 Node 缓冲无限增长（每连接
    // 可吃光内存），同时网关继续全速消费上游并烧额度。现在把写出交给 stream.ts 的
    // writer：write=false 时等 drain，并在等待期间同时响应 close/error 与
    // **gateway 暴露的合并信号**（内部 timeout / 撤权）。
    //
    // 两个控制器必须分开：`controller` 是 HTTP 边界从客户端断线推出来的取消源，
    // writer 需要能通过它主动 abort 上游；`result.signal` 是 gateway 内部
    // client+timeout+revocation 的合并结果，只用于**观察**。只监听前者时，gateway
    // 自己的 timeout/撤权只向内传播，唤不醒等 drain 的写循环 → iterator finally
    // 不结算、响应不 end()，连接与账本一起挂死。
    reply.hijack();
    const raw = reply.raw;
    const writer = createSseWriter({ writable: raw, upstream: controller, upstreamSignal: result.signal });
    raw.writeHead(result.status, { ...result.headers });
    try {
      for await (const chunk of result.stream) {
        if (raw.writableEnded || raw.destroyed) break;
        const written = await writer.write(chunk);
        // 非 written = 消费者不可写或上游已被中止：不再从上游拉取分片。
        if (written.status === "aborted") break;
      }
      if (!raw.writableEnded) raw.end();
    } catch {
      if (!raw.writableEnded) raw.end();
    } finally {
      raw.off("close", onClientClose);
      writer.dispose();
      request.raw.off("aborted", abort);
    }
    return reply;
  });

  return app;
}
