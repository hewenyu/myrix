import { once } from "node:events";
import Fastify, { errorCodes, type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { BibleKind, NovelPreset, SaveResult } from "@myrix/contracts";
import { registerAuth, requireIdentity, tokenHash, type AuthConfig } from "./auth";
import { ApiFailure, type DraftInput, type NovelRepository, type RuntimeRouter } from "./ports";

const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
const title = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const text = { type: "string", maxLength: 1_000_000 };
const params = (...names: string[]) => ({ type: "object", required: names, additionalProperties: false, properties: Object.fromEntries(names.map(name => [name, uuid])) });
const body = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", required, additionalProperties: false, properties });
const draft = body({ text, expectedVersion: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } });
type WorkParams = { workId: string };
type ChapterParams = WorkParams & { chapterId: string };
type SessionParams = { sessionId: string };

// Only Fastify's own request-parsing errors are client mistakes. Instances are
// checked against the constructor Fastify exports, never against a caller-supplied
// `statusCode`/`code` string, so an upstream or repository error cannot pose as a 4xx.
const clientParseFailures: readonly { is(error: FastifyError): boolean; statusCode: number; error: string; reason: string }[] = [
  { is: error => error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY, statusCode: 400, error: "invalid_input", reason: "请求正文为空，但 Content-Type 声明了 JSON" },
  { is: error => error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY, statusCode: 400, error: "invalid_input", reason: "请求正文不是合法的 JSON" },
  { is: error => error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE, statusCode: 413, error: "payload_too_large", reason: "请求正文超过大小上限" },
  { is: error => error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE, statusCode: 415, error: "unsupported_media_type", reason: "不支持的 Content-Type" },
];

// The only non-Fastify 4xx kept from before: @fastify/rate-limit throws a plain
// Error with statusCode 429. This cannot forge a client-input error (400/413/415).
const isRateLimited = (error: FastifyError): boolean => error.statusCode === 429;

export interface BffDependencies {
  auth: AuthConfig;
  repository: NovelRepository;
  runtime: RuntimeRouter;
  staticRoot?: string;
}

export async function createBffServer(deps: BffDependencies): Promise<FastifyInstance> {
  // Do not log request URLs: the OIDC callback carries a one-time authorization code.
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 2_000_000, requestTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false } } });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.code, reason: error.reason });
    if (error.validation) return reply.code(400).send({ error: "invalid_input", reason: "参数格式不正确或包含不允许的字段" });
    if (isRateLimited(error)) return reply.code(429).send({ error: "rate_limited", reason: "请求过于频繁，请稍后重试" });
    const parseFailure = clientParseFailures.find(candidate => candidate.is(error));
    if (parseFailure) return reply.code(parseFailure.statusCode).send({ error: parseFailure.error, reason: parseFailure.reason });
    return reply.code(503).send({ error: "service_unavailable", reason: "服务暂不可用；操作结果未知时，请先重新读取状态，不要盲目重试" });
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    return payload;
  });
  await registerAuth(app, deps.auth);
  const repo = deps.repository;
  const streams = new Set<AbortController>();
  app.addHook("preClose", async () => { for (const controller of streams) controller.abort(); });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/v1/works", async request => ({ items: await repo.listWorks(requireIdentity(request)) }));
  app.post<{ Body: { title: string; description: string } }>("/api/v1/works", {
    schema: { body: body({ title, description: { type: "string", maxLength: 4000 } }) },
  }, async (request, reply) => reply.code(201).send(await repo.createWork(requireIdentity(request), request.body)));
  app.get<{ Params: WorkParams }>("/api/v1/works/:workId", { schema: { params: params("workId") } },
    request => repo.getWork(requireIdentity(request), request.params.workId));
  app.delete<{ Params: WorkParams }>("/api/v1/works/:workId", { schema: { params: params("workId") } }, async (request, reply) => {
    await repo.deleteWork(requireIdentity(request), request.params.workId);
    return reply.code(204).send();
  });
  app.get<{ Params: WorkParams }>("/api/v1/works/:workId/outline", { schema: { params: params("workId") } },
    request => repo.getOutline(requireIdentity(request), request.params.workId));
  const saved = (result: SaveResult): number => result.status === "conflict" ? 409 : 200;
  app.put<{ Params: WorkParams; Body: DraftInput }>("/api/v1/works/:workId/outline", { schema: { params: params("workId"), body: draft } }, async (request, reply) => {
    const result = await repo.saveOutline(requireIdentity(request), request.params.workId, request.body);
    return reply.code(saved(result)).send(result);
  });
  app.get<{ Params: WorkParams }>("/api/v1/works/:workId/chapters", { schema: { params: params("workId") } },
    async request => ({ items: await repo.listChapters(requireIdentity(request), request.params.workId) }));
  app.post<{ Params: WorkParams; Body: { title: string } }>("/api/v1/works/:workId/chapters", { schema: { params: params("workId"), body: body({ title }) } },
    async (request, reply) => reply.code(201).send(await repo.createChapter(requireIdentity(request), request.params.workId, request.body)));
  app.get<{ Params: ChapterParams }>("/api/v1/works/:workId/chapters/:chapterId", { schema: { params: params("workId", "chapterId") } },
    request => repo.getChapter(requireIdentity(request), request.params.workId, request.params.chapterId));
  app.put<{ Params: ChapterParams; Body: DraftInput }>("/api/v1/works/:workId/chapters/:chapterId", { schema: { params: params("workId", "chapterId"), body: draft } }, async (request, reply) => {
    const result = await repo.saveChapter(requireIdentity(request), request.params.workId, request.params.chapterId, request.body);
    return reply.code(saved(result)).send(result);
  });
  app.get<{ Params: ChapterParams }>("/api/v1/works/:workId/chapters/:chapterId/versions", { schema: { params: params("workId", "chapterId") } },
    async request => ({ items: await repo.chapterVersions(requireIdentity(request), request.params.workId, request.params.chapterId) }));
  app.get<{ Params: WorkParams; Querystring: { query?: string } }>("/api/v1/works/:workId/bible", {
    schema: { params: params("workId"), querystring: body({ query: { type: "string", maxLength: 1000 } }, []) },
  }, async request => ({ items: await repo.listBible(requireIdentity(request), request.params.workId, request.query.query ?? "") }));
  app.post<{ Params: WorkParams; Body: { kind: BibleKind; title: string; text: string } }>("/api/v1/works/:workId/bible", {
    schema: { params: params("workId"), body: body({ kind: { type: "string", enum: ["character", "setting", "timeline"] }, title, text }) },
  }, async (request, reply) => reply.code(201).send(await repo.createBible(requireIdentity(request), request.params.workId, request.body)));
  app.put<{ Params: WorkParams & { entryId: string }; Body: DraftInput }>("/api/v1/works/:workId/bible/:entryId", {
    schema: { params: params("workId", "entryId"), body: draft },
  }, async (request, reply) => {
    const result = await repo.saveBible(requireIdentity(request), request.params.workId, request.params.entryId, request.body);
    return reply.code(saved(result)).send(result);
  });
  app.get<{ Params: WorkParams }>("/api/v1/works/:workId/sessions", { schema: { params: params("workId") } },
    async request => ({ items: await repo.listSessions(requireIdentity(request), request.params.workId) }));
  app.post<{ Params: WorkParams; Body: { preset: NovelPreset } }>("/api/v1/works/:workId/sessions", {
    // `novel-assistant` 是统一创作助手（六工具全集）。浏览器仍可显式选择历史 preset；
    // 服务端默认值（novel-web 传 novel-assistant）表达"作者不需要选 preset"。
    schema: { params: params("workId"), body: body({ preset: { type: "string", enum: ["novel-assistant", "novel-outline", "novel-chapter", "novel-bible"] } }) },
  }, async (request, reply) => reply.code(201).send(await deps.runtime.createSession(requireIdentity(request), request.params.workId, request.body.preset)));
  app.post<{ Params: SessionParams; Body: { commandId: string; text: string } }>("/api/v1/sessions/:sessionId/messages", {
    schema: { params: params("sessionId"), body: body({ commandId: uuid, text: { type: "string", minLength: 1, maxLength: 100_000, pattern: "\\S" } }) },
  }, async (request, reply) => reply.code(202).send(await deps.runtime.send(requireIdentity(request), request.params.sessionId, request.body)));
  app.post<{ Params: SessionParams; Body: { commandId: string } }>("/api/v1/sessions/:sessionId/cancel", {
    schema: { params: params("sessionId"), body: body({ commandId: uuid }) },
  }, async (request, reply) => reply.code(202).send(await deps.runtime.cancel(requireIdentity(request), request.params.sessionId, request.body.commandId)));
  // 归档是展示元数据（不是撤权）：显式布尔值，缺字段即 400（fail-closed，不接受默认值）。
  // CSRF / Origin 校验由 registerAuth 的统一 hook 覆盖（PATCH 属于 mutating 方法）。
  app.patch<{ Params: SessionParams; Body: { archived: boolean } }>("/api/v1/sessions/:sessionId", {
    schema: { params: params("sessionId"), body: body({ archived: { type: "boolean" } }) },
  }, async request => deps.runtime.archive(requireIdentity(request), request.params.sessionId, request.body.archived));
  app.delete<{ Params: SessionParams }>("/api/v1/sessions/:sessionId", { schema: { params: params("sessionId") } }, async (request, reply) => {
    await deps.runtime.revoke(requireIdentity(request), request.params.sessionId);
    return reply.code(204).send();
  });
  app.get<{ Params: SessionParams }>("/api/v1/sessions/:sessionId/events", { schema: { params: params("sessionId") } }, async (request, reply) => {
    const rawCursor = request.headers["last-event-id"] ?? "0";
    if (typeof rawCursor !== "string" || !/^\d{1,16}$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
      throw new ApiFailure(400, "invalid_cursor", "事件续传游标无效");
    }
    const abort = new AbortController();
    streams.add(abort);
    abort.signal.addEventListener("abort", () => { if (reply.sent) reply.raw.end(); }, { once: true });
    const close = () => abort.abort();
    reply.raw.once("close", close);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checkAuth: ReturnType<typeof setInterval> | undefined;
    try {
      const events = await deps.runtime.events(requireIdentity(request), request.params.sessionId, Number(rawCursor), abort.signal);
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" });
      reply.raw.write(": connected\n\n");
      heartbeat = setInterval(() => {
        if (reply.raw.writableLength > 1_000_000) abort.abort();
        else reply.raw.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref();
      let checking = false;
      checkAuth = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          const cookie = request.cookies.myrix_session;
          const session = cookie && await deps.auth.repository.findSession(tokenHash(cookie));
          if (!session || session.expiresAt.getTime() <= (deps.auth.now?.() ?? new Date()).getTime() || !await deps.auth.repository.identity(session.actor)) abort.abort();
        })().catch(() => abort.abort()).finally(() => { checking = false; });
      }, 5_000);
      checkAuth.unref();
      for await (const event of events) {
        if (abort.signal.aborted) break;
        const durable = event.type !== "delta" && event.seq !== undefined && Number.isSafeInteger(event.seq) && event.seq >= 0;
        const payload = durable ? event : { ...event, seq: undefined };
        const data = `${durable ? `id: ${event.seq}\n` : ""}event: message\ndata: ${JSON.stringify(payload)}\n\n`;
        if (!reply.raw.write(data)) await once(reply.raw, "drain", { signal: abort.signal });
      }
    } catch (error) {
      if (!reply.sent) throw error;
      if (!abort.signal.aborted && !reply.raw.destroyed) reply.raw.write(`event: message\ndata: ${JSON.stringify({ type: "error", text: "会话事件流中断，请重新连接以恢复持久消息" })}\n\n`);
    } finally {
      abort.abort();
      streams.delete(abort);
      if (heartbeat) clearInterval(heartbeat);
      if (checkAuth) clearInterval(checkAuth);
      reply.raw.off("close", close);
      if (reply.sent) reply.raw.end();
    }
  });
  if (deps.staticRoot) {
    await app.register(fastifyStatic, { root: deps.staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url.startsWith("/api/") || request.url.includes(".")) {
        return reply.code(404).send({ error: "not_found", reason: "接口或资源不存在" });
      }
      return reply.sendFile("index.html");
    });
  }
  return app;
}
