import { describe, expect, it, vi } from "vitest";
import { CellCredentialRegistry, createWorksServer, resolveSnapshotPolicy } from "../src/works-server";
import { ApiFailure } from "../src/ports";
const sid = "10000000-0000-4000-8000-000000000001";
const url = `/internal/v1/sessions/${sid}/tools/update_outline`;
const headers = { authorization: "Bearer cell-credential", "x-myrix-revision": "2" };
describe("internal works transport (executor double, not RLS proof)", () => {
  it("rejects injected identity, unknown tools and malformed revisions before dispatch", async () => {
    const execute = vi.fn(async () => ({}));
    const app = await createWorksServer(execute);
    for (const payload of [{ text: "x", expectedVersion: 0, tenantId: sid }, { text: "x", expectedVersion: -1 }]) {
      expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url, headers: { ...headers, "x-myrix-revision": "9007199254740993" }, payload: { text: "x", expectedVersion: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/internal/v1/sessions/${sid}/tools/bash`, headers, payload: {} })).statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
  it("returns CAS conflict and passes only validated arguments", async () => {
    const execute = vi.fn(async () => ({ status: "conflict", version: 3 }));
    const app = await createWorksServer(execute);
    const response = await app.inject({ method: "POST", url, headers, payload: { text: "draft", expectedVersion: 2 } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ result: { status: "conflict", version: 3 } });
    expect(execute).toHaveBeenCalledWith(headers.authorization, sid, 2, "update_outline", { text: "draft", expectedVersion: 2 });
    await app.close();
  });
  it("exposes readable denial without exposing unexpected errors", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new ApiFailure(403, "revoked", "会话已撤权")).mockRejectedValueOnce(new Error("postgres://secret"));
    const app = await createWorksServer(execute);
    const request = { method: "POST" as const, url, headers, payload: { text: "x", expectedVersion: 0 } };
    expect((await app.inject(request)).json()).toEqual({ error: "revoked", reason: "会话已撤权" });
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("secret");
    await app.close();
  });
  it("uses explicit strong per-cell secrets and rejects missing, shared or malformed credentials", () => {
    const token = "s".repeat(48);
    const registry = new CellCredentialRegistry([{ tenantId: sid, cellId: "cell-a", token }]);
    expect(registry.resolve(`Bearer ${token}`)).toEqual({ tenantId: sid, cellId: "cell-a" });
    for (const auth of [undefined, "Bearer incorrect", `Bearer ${token} extra`, `bearer ${token}`]) expect(() => registry.resolve(auth)).toThrow("无效");
    expect(() => new CellCredentialRegistry([{ tenantId: sid, cellId: "cell-a", token: "short" }])).toThrow();
    expect(() => new CellCredentialRegistry([{ tenantId: sid, cellId: "cell-a", token }, { tenantId: sid, cellId: "cell-b", token }])).toThrow("shared");
  });

  it("serves the bindings endpoint only when a reader is configured, with no-store and no secrets", async () => {
    const token = "s".repeat(48);
    const registry = new CellCredentialRegistry([{ tenantId: sid, cellId: "cell-a", token }]);
    const withoutReader = await createWorksServer(vi.fn(async () => ({})));
    const missing = await withoutReader.inject({ method: "GET", url: "/internal/v1/cells/cell-a/bindings", headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ error: "bindings_unavailable" });
    await withoutReader.close();

    const readBindings = vi.fn(async (authorization: string | undefined, cellId: string) => {
      registry.resolve(authorization);
      if (cellId !== "cell-a") throw new ApiFailure(403, "wrong_cell", "服务凭据不属于此 Cell");
      return { cellId, tenantId: sid, bindings: [] };
    });
    const app = await createWorksServer(vi.fn(async () => ({})), readBindings);
    const denied = await app.inject({ method: "GET", url: "/internal/v1/cells/cell-a/bindings" });
    expect(denied.statusCode).toBe(401);
    const wrongCell = await app.inject({ method: "GET", url: "/internal/v1/cells/cell-b/bindings", headers: { authorization: `Bearer ${token}` } });
    expect(wrongCell.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: "/internal/v1/cells/cell-a/bindings", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body).not.toContain(token);
    await app.close();
  });
});

describe("deployment-controlled snapshot policy (six known novel tools only)", () => {
  it("omitting the third argument is explicit: no policy field is emitted", () => {
    expect(resolveSnapshotPolicy(undefined)).toBeUndefined();
  });

  it("keeps only the six known novel tools, de-duplicated and frozen", () => {
    const policy = resolveSnapshotPolicy({ rev: 3, ttlMs: 10_000, tools: ["get_outline", "get_outline", "search_bible"] });
    expect(policy).toEqual({ rev: 3, ttlMs: 10_000, tools: ["get_outline", "search_bible"] });
    expect(Object.isFrozen(policy?.tools)).toBe(true);
  });

  it("an explicit empty tools array stays empty: it means deny-all, not 'no policy'", () => {
    expect(resolveSnapshotPolicy({ rev: 1, ttlMs: 1_000, tools: [] })?.tools).toEqual([]);
  });

  it("rejects malformed deployments at construction instead of silently narrowing", () => {
    expect(() => resolveSnapshotPolicy({ rev: -1, ttlMs: 1_000, tools: [] })).toThrow(/rev/);
    expect(() => resolveSnapshotPolicy({ rev: 1, ttlMs: 0, tools: [] })).toThrow(/ttlMs/);
    expect(() => resolveSnapshotPolicy({ rev: 1, ttlMs: 30_001, tools: [] })).toThrow(/ttlMs/);
    expect(() => resolveSnapshotPolicy({ rev: 1, ttlMs: 1_000, tools: "get_outline" as unknown as readonly string[] })).toThrow(/数组/);
    // 未知工具名不会被静默丢掉，而是启动即失败：静默收窄会表现为"工具莫名被拒"。
    expect(() => resolveSnapshotPolicy({ rev: 1, ttlMs: 1_000, tools: ["bash"] })).toThrow(/未知工具名/);
  });
});
