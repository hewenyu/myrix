import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDevelopmentConfig } from "../scripts/dev-config";

const harness = vi.hoisted(() => ({
  read: vi.fn(), access: vi.fn(), mkdir: vi.fn(), unlink: vi.fn(), lstat: vi.fn(),
  lockWrite: vi.fn(), lockClose: vi.fn(), spawn: vi.fn(), profile: vi.fn(),
}));
vi.mock("../scripts/dev-config", async importOriginal => ({
  ...await importOriginal<typeof import("../scripts/dev-config")>(), readDevelopmentConfig: harness.read,
}));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: harness.access, mkdir: harness.mkdir, unlink: harness.unlink, lstat: harness.lstat,
  open: vi.fn(async (path: string) => path.endsWith("dev-runtime.lock")
    ? { writeFile: harness.lockWrite, sync: async () => undefined, close: harness.lockClose, stat: async () => ({ ino: 101, dev: 1 }) }
    : { fd: 99, close: async () => undefined }),
}));
vi.mock("node:net", () => ({ createServer: () => {
  const server = { once: () => server, listen: (_port: number, _host: string, ready: () => void) => ready(), close: (done: () => void) => done() };
  return server;
} }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: harness.spawn,
}));
vi.mock("../../../tests/poc/lib/cell-profile.mjs", () => ({
  createCellProfile: harness.profile,
  cellEnv: (cell: { home: string }, base: NodeJS.ProcessEnv) => ({ ...base, DSH_HOME: cell.home, MYRIX_WORKS_TOKEN: "own-token" }),
}));
import { startDevelopment } from "../scripts/start-dev";

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };
let children: FakeChild[];
const parent = { PATH: "/usr/bin", MYRIX_GATEWAY_UPSTREAM_URL: "https://models.example/v1/responses", MYRIX_GATEWAY_UPSTREAM_MODEL: "fixture-model", MYRIX_GATEWAY_UPSTREAM_API_KEY: "fixture-key", MYRIX_MODEL_CONTEXT_WINDOW: "65536" };

beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  harness.read.mockResolvedValue(makeDevelopmentConfig("postgres://migrator:fixture@127.0.0.1:55439/myrix", "/fixture/dist"));
  harness.access.mockResolvedValue(undefined);
  harness.mkdir.mockResolvedValue(undefined);
  harness.unlink.mockResolvedValue(undefined);
  harness.lockWrite.mockResolvedValue(undefined);
  harness.lockClose.mockResolvedValue(undefined);
  harness.lstat.mockResolvedValue({ ino: 101, dev: 1, isSymbolicLink: () => false });
  harness.profile.mockImplementation((options: { home: string; port: number }) => ({
    home: options.home, profileName: "myrix-cell", cellUrl: `http://127.0.0.1:${options.port}`,
    install: { cli: "/fixture/dsh.mjs", version: "0.2.0-rc.2" }, linkBundle: vi.fn(),
  }));
  harness.spawn.mockImplementation(() => {
    const child = new EventEmitter() as FakeChild;
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); return true; });
    children.push(child);
    return child;
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("development launcher orchestration (mocked processes, not end-to-end acceptance)", () => {
  it("checks cancellation before reading private configuration or spawning children", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(startDevelopment(parent, controller.signal)).rejects.toThrow("cancelled");
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("starts four isolated services, uses the Responses base path and closes all children exactly once", async () => {
    const application = await startDevelopment({ ...parent, NODE_OPTIONS: "--import unsafe.mjs", DATABASE_URL: "ambient-superuser" });
    expect(children).toHaveLength(4);
    expect(harness.profile).toHaveBeenCalledTimes(2);
    for (const [options] of harness.profile.mock.calls) expect(options).toMatchObject({ gatewayBaseURL: "http://127.0.0.1:8790/v1", routeSeam: "none", probe: false });
    const gatewayEnv = harness.spawn.mock.calls[0]![2].env;
    const bffEnv = harness.spawn.mock.calls[1]![2].env;
    expect(gatewayEnv.MYRIX_GATEWAY_UPSTREAM_API_KEY).toBe("fixture-key");
    expect(bffEnv.MYRIX_GATEWAY_UPSTREAM_API_KEY).toBeUndefined();
    for (const [, , options] of harness.spawn.mock.calls) expect(options.env.NODE_OPTIONS).toBeUndefined();
    for (const [, , options] of harness.spawn.mock.calls.slice(2)) {
      expect(options.env.DATABASE_URL).toBeUndefined();
      expect(options.env.MYRIX_GATEWAY_UPSTREAM_API_KEY).toBeUndefined();
      expect(options.env.MYRIX_RUNTIME_SIGNING_KEY_PEM).toBeUndefined();
    }
    await Promise.all([application.close(), application.close()]);
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
    expect(harness.unlink).toHaveBeenCalledTimes(1);
    expect(harness.lockClose).toHaveBeenCalledTimes(1);
  });

  it("cancels while BFF/gateway readiness is pending and leaves no child or lock behind", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(new Error("startup interrupted")); throw new Error("aborted"); }));
    await expect(startDevelopment(parent, controller.signal)).rejects.toThrow("startup interrupted");
    expect(children).toHaveLength(2);
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
    expect(harness.unlink).toHaveBeenCalledTimes(1);
  });

  it("releases a successfully acquired lock when writing its pid fails", async () => {
    harness.lockWrite.mockRejectedValueOnce(new Error("disk full"));
    await expect(startDevelopment(parent)).rejects.toThrow("disk full");
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.unlink).toHaveBeenCalledTimes(1);
    expect(harness.lockClose).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when creating the private log directory fails", async () => {
    harness.mkdir.mockRejectedValueOnce(new Error("permission denied"));
    await expect(startDevelopment(parent)).rejects.toThrow("permission denied");
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.unlink).toHaveBeenCalledTimes(1);
  });

  it("does not delete a replaced lock pathname, but still stops children and closes its descriptor", async () => {
    const application = await startDevelopment(parent);
    harness.lstat.mockResolvedValue({ ino: 202, dev: 1, isSymbolicLink: () => false });
    await expect(application.close()).rejects.toThrow("锁文件已被替换");
    expect(harness.unlink).not.toHaveBeenCalled();
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
    expect(harness.lockClose).toHaveBeenCalledTimes(1);
  });

  it("refuses startup without an explicit model context window", async () => {
    await expect(startDevelopment({ ...parent, MYRIX_MODEL_CONTEXT_WINDOW: undefined })).rejects.toThrow("MYRIX_MODEL_CONTEXT_WINDOW");
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});
