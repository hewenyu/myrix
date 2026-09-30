import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntitlementGrant, PolicyResource } from "@myrix/contracts";
import { Router, json, readJsonBody, type HttpResponse, type RequestContext } from "./http";
import type { GovernanceStore } from "./store";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface ControlPlaneOptions {
  store: GovernanceStore;
  adminToken: string;
  consoleDir?: string;
  now?: () => Date;
}

export interface ControlPlane {
  server: Server;
  router: Router;
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
}

/**
 * LLM 网关契约（声明式）：Myrix 不在 DSH 内做模型治理，
 * 只要求网关实现这些能力，并用同一套 trace 字段回传审计。
 */
const GATEWAY_CONTRACT = {
  boundary: "LLM 网关（企业既有，或 ai-gateway 类服务）",
  responsibilities: [
    "模型路由与降级：按 tenant/principal/agent 选择供应商与模型版本",
    "配额与限流：tokens/min、并发数、成本预算（obligation: rateLimit 下发到网关）",
    "模型白名单：消费 obligation: modelScope，拒绝越权模型调用",
    "提示词与响应审计：落库并要求与治理事件共享 traceId",
    "密钥托管：上游 API Key 不进入 DSH 运行时与用户终端",
  ],
  requestHeaders: {
    "x-myrix-tenant": "租户标识",
    "x-myrix-principal": "主体标识（用户/服务账号）",
    "x-myrix-session": "DSH 会话标识",
    "x-myrix-agent": "agent 标识（子代理、工作流）",
    "x-myrix-trace": "端到端 traceId，治理事件与模型审计共用",
  },
  auditJoinKeys: ["traceId", "tenantId", "principalId", "sessionId"],
};

function buildRouter(store: GovernanceStore, now: () => Date): Router {
  const router = new Router();

  router.get("/healthz", () => json(200, { status: "ok", ts: now().toISOString() }));

  router.get("/api/v1/meta", () =>
    json(200, {
      product: "myrix",
      version: "0.1.0",
      policyRevision: store.policyRevision,
      upstream: {
        repo: "git@github.com:hewenyu/deepseek-harness.git",
        submodule: "vendor/deepseek-harness",
        pinnedRef: "639ed015397290b3745d163aafe02ffee4aa3f84 (dsh 0.2.0-rc.2 之后一次合并)",
      },
      tenants: store.tenants,
    }),
  );

  router.get("/api/v1/principals", (ctx) =>
    json(200, { items: store.listPrincipals(ctx.query.get("tenantId") ?? undefined) }),
  );

  router.get("/api/v1/principals/:id", (ctx) => {
    const principal = store.getPrincipal(ctx.params.id ?? "");
    if (!principal) return json(404, { error: "principal_not_found" });
    const access = store.resolveAccess(principal.id);
    return json(200, {
      principal,
      roles: access?.roles ?? [],
      permissions: access?.permissions ?? [],
      unresolvedRoles: access?.unresolvedRoles ?? [],
    });
  });

  router.get("/api/v1/roles", () => json(200, { items: store.listRoles() }));

  router.get("/api/v1/policies", () => json(200, { revision: store.policyRevision, items: store.policies }));

  router.get("/api/v1/plugins", () =>
    json(200, {
      items: store.catalog.list(),
      stats: {
        total: store.catalog.list().length,
        highRisk: store.catalog.list().filter((plugin) => plugin.risk === "high").length,
      },
    }),
  );

  router.post("/api/v1/decisions", (ctx) => {
    const body = (ctx.body ?? {}) as {
      principalId?: string;
      action?: string;
      resource?: PolicyResource;
      context?: Record<string, unknown>;
      tenantId?: string;
    };
    if (!body.principalId || !body.action || !body.resource) {
      return json(400, { error: "invalid_request", required: ["principalId", "action", "resource"] });
    }
    const envelope = store.decide({
      principalId: body.principalId,
      action: body.action,
      resource: body.resource,
      ...(body.context === undefined ? {} : { context: body.context }),
    });
    return json(200, envelope);
  });

  router.get("/api/v1/principals/:id/entitlements", (ctx) => {
    const set = store.entitlements(ctx.params.id ?? "");
    if (!set) return json(404, { error: "principal_not_found" });
    return json(200, set);
  });

  router.get("/api/v1/principals/:id/profile", (ctx) => {
    const profile = store.profile(ctx.params.id ?? "");
    if (!profile) return json(404, { error: "principal_not_found" });
    return json(200, { spec: profile.spec, yaml: profile.yaml });
  });

  router.get("/api/v1/knowledge/bases", async (ctx) => {
    const principalId = ctx.query.get("principalId");
    if (!principalId) return json(400, { error: "principalId_required" });
    const principal = store.getPrincipal(principalId);
    if (!principal) return json(404, { error: "principal_not_found" });
    const subject = { ...store.subjectContext(principal) };
    const result = await store.federation.listBases(subject);
    return json(200, result);
  });

  router.post("/api/v1/knowledge/search", async (ctx) => {
    const body = (ctx.body ?? {}) as { principalId?: string; text?: string; baseIds?: string[]; topK?: number };
    if (!body.principalId || body.text === undefined) {
      return json(400, { error: "invalid_request", required: ["principalId", "text"] });
    }
    const principal = store.getPrincipal(body.principalId);
    if (!principal) return json(404, { error: "principal_not_found" });
    const subject = { ...store.subjectContext(principal) };
    const result = await store.federation.search(subject, { text: body.text, topK: body.topK ?? 5 }, {
      ...(body.baseIds === undefined ? {} : { baseIds: body.baseIds }),
    });
    store.record({
      category: "knowledge-access",
      tenantId: principal.tenantId,
      principalId: principal.id,
      action: "kb:search",
      resource: "kb:" + result.searchedBases.join(","),
      effect: result.errors.length > 0 ? "deny" : "allow",
      detail: { hits: result.chunks.length, errors: result.errors },
    });
    return json(200, result);
  });

  router.get("/api/v1/audit", (ctx) => {
    const limit = Number(ctx.query.get("limit") ?? "50");
    return json(200, { items: store.listAudit(Number.isFinite(limit) ? limit : 50) });
  });

  router.post("/api/v1/admin/grants", (ctx) => {
    const body = (ctx.body ?? {}) as Partial<EntitlementGrant>;
    if (!body.pluginId || !body.grantee || !body.tenantId) {
      return json(400, { error: "invalid_request", required: ["pluginId", "grantee", "tenantId"] });
    }
    if (!store.catalog.get(body.pluginId)) return json(404, { error: "plugin_not_found" });
    const grant: EntitlementGrant = {
      pluginId: body.pluginId,
      tenantId: body.tenantId,
      grantee: body.grantee,
      grantedBy: body.grantedBy ?? "admin:unknown",
      grantedAt: now().toISOString(),
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      ...(body.constraints === undefined ? {} : { constraints: body.constraints }),
    };
    return json(201, store.addGrant(grant));
  });

  router.get("/api/v1/grants", () => json(200, { items: store.grants }));

  router.get("/api/v1/gateway/contract", () => json(200, GATEWAY_CONTRACT));

  return router;
}

async function serveStatic(consoleDir: string, pathname: string): Promise<HttpResponse> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(consoleDir, relative);
  const root = resolve(consoleDir) + sep;
  if (target !== resolve(consoleDir) && !target.startsWith(root)) return json(403, { error: "forbidden" });
  try {
    const content = await readFile(target);
    return {
      status: 200,
      headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" },
      body: content,
    };
  } catch {
    return json(404, { error: "not_found", path: pathname });
  }
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const now = options.now ?? (() => new Date());
  const router = buildRouter(options.store, now);
  const consoleDir = options.consoleDir ?? fileURLToPath(new URL("../../../apps/console/public/", import.meta.url));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const isApi = url.pathname.startsWith("/api/");
      try {
        if (isApi) {
          const header = req.headers.authorization ?? "";
          const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
          if (token !== options.adminToken) {
            respond(res, json(401, { error: "unauthorized", hint: "使用 Authorization: Bearer <MYRIX_ADMIN_TOKEN>" }));
            return;
          }
        }
        const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
          ? await readJsonBody(req)
          : undefined;
        const ctx: RequestContext = {
          method: req.method ?? "GET",
          url,
          params: {},
          query: url.searchParams,
          body,
          req,
        };
        const routed = await router.handle(ctx);
        if (routed) {
          respond(res, routed);
          return;
        }
        if (isApi) {
          respond(res, json(404, { error: "not_found", path: url.pathname }));
          return;
        }
        const response = await serveStatic(consoleDir, url.pathname);
        respond(res, response);
      } catch (error) {
        respond(
          res,
          json(500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) }),
        );
      }
    })();
  });

  return {
    server,
    router,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolvePromise) => {
        server.listen(port, host, () => {
          const address = server.address();
          const actualPort = typeof address === "object" && address !== null ? address.port : port;
          resolvePromise({ port: actualPort, url: "http://" + host + ":" + actualPort.toString() });
        });
      }),
  };
}

function respond(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

export { GATEWAY_CONTRACT };
export type { PolicyResource };
