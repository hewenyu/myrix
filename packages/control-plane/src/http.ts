import type { IncomingMessage } from "node:http";

export interface RequestContext {
  method: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(status: number, payload: unknown): HttpResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(payload, null, 2) + "\n" };
}

export function text(status: number, body: string, contentType = "text/plain; charset=utf-8"): HttpResponse {
  return { status, headers: { "content-type": contentType, "cache-control": "no-store" }, body };
}

export function empty(status: number): HttpResponse {
  return { status, headers: {}, body: "" };
}

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResponse> | HttpResponse;

export interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternSegments = pattern.split("/").filter((segment) => segment.length > 0);
  const pathSegments = pathname.split("/").filter((segment) => segment.length > 0);
  if (patternSegments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] ?? "";
    const actual = pathSegments[index] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error("请求体超过上限");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }

  async handle(ctx: RequestContext): Promise<HttpResponse | undefined> {
    let methodMismatch = false;
    for (const route of this.routes) {
      const params = matchPath(route.path, ctx.url.pathname);
      if (params === undefined) continue;
      if (route.method !== ctx.method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      return await route.handler({ ...ctx, params });
    }
    if (methodMismatch) return json(405, { error: "method_not_allowed" });
    return undefined;
  }
}
