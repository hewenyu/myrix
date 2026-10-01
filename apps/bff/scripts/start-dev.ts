import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readDevelopmentConfig } from "./dev-config";
import { assertCellSecretIsolation, operatingEnvironment, serviceEnvironment } from "./child-environment";
import { readStartupEnvironment } from "../src/startup-config";
import { resolveGatewayConfig } from "../../model-gateway/src/config";
import { NOVEL_TOOLS } from "../../../plugins/myrix-novel/src/protocol";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
class DevelopmentStartupError extends Error {}
type CellProfile = { home: string; profileName: string; install: { cli: string; version: string }; cellUrl: string; linkBundle(): string };
type ProfileFactory = {
  createCellProfile(options: Record<string, unknown>): CellProfile;
  cellEnv(cell: CellProfile, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
type RunningChild = { name: string; process: ChildProcess; exited: Promise<void>; hasExited: boolean };

async function freePort(port: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const server = createServer();
    server.once("error", () => reject(new DevelopmentStartupError(`本地端口 ${port} 已占用；不会停止或替换既有进程`)));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(new DevelopmentStartupError("端口检查失败")) : done()));
  });
}

/** Real local stack: persistent BFF + gateway + two isolated compiled DSH Cells; no fake model in this entry. */
export async function startDevelopment(parent: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const config = await readDevelopmentConfig(resolve(root, "data/dev-runtime.json"));
  const startup = readStartupEnvironment(config.env);
  const gatewayEnv = serviceEnvironment("gateway", config.env, parent);
  const gateway = resolveGatewayConfig(gatewayEnv);
  const contextWindow = Number(parent.MYRIX_MODEL_CONTEXT_WINDOW);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096) throw new DevelopmentStartupError("必须显式设置 MYRIX_MODEL_CONTEXT_WINDOW（至少 4096），与所选模型的能力匹配");
  await access(resolve(root, "apps/novel-web/dist/index.html")).catch(() => { throw new DevelopmentStartupError("缺少前端构建；请先执行 pnpm build:web"); });
  for (const cell of config.cells) {
    const placement = startup.runtime.cells.find(row => row.cellId === cell.cellId && row.tenantId === cell.tenantId);
    if (!/^[a-z0-9-]{1,64}$/.test(cell.cellId) || ![7801, 7802].includes(cell.port)
      || placement?.baseUrl !== `http://127.0.0.1:${cell.port}` || placement.serviceToken !== cell.serviceToken
      || startup.registry.resolve(`Bearer ${cell.token}`).cellId !== cell.cellId) throw new DevelopmentStartupError("Cell 开发配置与服务端部署清单不一致");
  }
  const ports = [startup.bff.port, startup.worksPort, gateway.port, ...config.cells.map(cell => cell.port)];
  if (new Set(ports).size !== ports.length) throw new DevelopmentStartupError("开发端口必须互不相同");
  await Promise.all(ports.map(freePort));
  const profileFactory = await import(pathToFileURL(resolve(root, "tests/poc/lib/cell-profile.mjs")).href) as ProfileFactory;
  const lockPath = resolve(root, "data/dev-runtime.lock");
  signal?.throwIfAborted();
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new DevelopmentStartupError("无法独占创建开发栈锁；先检查目录权限和旧进程，不会覆盖锁或终止既有进程"); });
  // Keep the descriptor until cleanup so we can prove the pathname is still our inode.
  const children: RunningChild[] = [];
  const logDirectory = resolve(root, "data/dev-logs");
  let closing: Promise<void> | undefined;
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Install a rejection handler immediately, including while startup is still waiting for health checks.
  void failure.catch(() => undefined);
  const close = (): Promise<void> => closing ??= (async () => {
    for (const child of [...children].reverse()) if (!child.hasExited) child.process.kill("SIGTERM");
    const deadline = setTimeout(() => { for (const child of children) if (!child.hasExited) child.process.kill("SIGKILL"); }, 15_000);
    deadline.unref();
    await Promise.all(children.map(child => child.exited));
    clearTimeout(deadline);
    // Verify the absolute deletion target: this process owns only this successfully acquired lock.
    try {
      if (dirname(lockPath) !== resolve(root, "data") || basename(lockPath) !== "dev-runtime.lock") throw new DevelopmentStartupError("拒绝清理非预期锁路径");
      const owned = await lock.stat();
      const current = await lstat(lockPath).catch(error => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (current && (current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev)) throw new DevelopmentStartupError("锁文件已被替换，拒绝删除非本进程持有的锁");
      if (current) await unlink(lockPath);
    } finally { await lock.close(); }
  })();
  const launch = async (name: string, args: string[], env: NodeJS.ProcessEnv) => {
    signal?.throwIfAborted();
    const log = await open(resolve(logDirectory, `${Date.now()}-${name}.log`), "wx", 0o600);
    try {
      signal?.throwIfAborted();
      if (closing) throw new DevelopmentStartupError("开发栈正在关闭，拒绝启动新进程");
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", log.fd, log.fd] });
      let done!: () => void;
      const record: RunningChild = { name, process: child, exited: new Promise<void>(resolveExit => { done = resolveExit; }), hasExited: false };
      children.push(record);
      const finish = () => {
        if (record.hasExited) return;
        record.hasExited = true; done();
        if (!closing) fail(new DevelopmentStartupError(`${name} 提前退出；请检查 data/dev-logs 下该服务的私有日志`));
      };
      child.once("error", finish);
      child.once("exit", finish);
    } finally { await log.close(); }
  };
  const healthy = async (url: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500);
      const ok = await fetch(url, { signal: requestSignal, redirect: "error" }).then(async response => { await response.body?.cancel(); return response.ok; }).catch(() => false);
      signal?.throwIfAborted();
      if (ok) return;
      await Promise.race([delay(250, undefined, { signal }), failure]);
    }
    throw new DevelopmentStartupError("本地服务就绪超时；请检查 data/dev-logs 私有日志");
  };
  try {
    signal?.throwIfAborted();
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const profiles = config.cells.map(cell => profileFactory.createCellProfile({
      repo: root, home: resolve(root, "data/cells", cell.cellId), profileName: "myrix-cell",
      cellId: cell.cellId, tenantId: cell.tenantId, issuer: config.env.MYRIX_RUNTIME_ISSUER,
      grantPublicJwks: config.publicKeys, host: "127.0.0.1", port: cell.port,
      worksOrigin: `http://127.0.0.1:${startup.worksPort}`, worksToken: cell.token,
      gatewayBaseURL: `http://127.0.0.1:${gateway.port}/v1`, gatewayToken: cell.token,
      providers: ["myrix-gateway"], models: [gateway.upstream.model], contextWindow,
      drainToken: cell.serviceToken, revokeToken: cell.serviceToken,
      allowedTools: [...NOVEL_TOOLS], routeSeam: "none", probe: false,
    }));
    for (const profile of profiles) {
      if (profile.install.version !== "0.2.0-rc.2") throw new DevelopmentStartupError("DSH 安装版本不是锁定的 0.2.0-rc.2；拒绝使用环境中其他安装");
      profile.linkBundle();
    }
    await launch("gateway", ["--import", "tsx", "apps/model-gateway/src/bin.ts"], gatewayEnv);
    await launch("bff", ["--import", "tsx", "apps/bff/src/bin.ts"], serviceEnvironment("bff", config.env, parent));
    await Promise.race([Promise.all([healthy(`http://127.0.0.1:${gateway.port}/healthz`), healthy(`${startup.bff.origin}/api/v1/auth/config`)]), failure]);
    for (const [index, profile] of profiles.entries()) {
      const env = profileFactory.cellEnv(profile, operatingEnvironment(parent));
      assertCellSecretIsolation(env);
      await launch(`cell-${index + 1}`, [profile.install.cli, "--profile", profile.profileName], env);
    }
    await Promise.race([Promise.all(profiles.map(profile => healthy(`${profile.cellUrl}/v1/ready`))), failure]);
    console.log(`Myrix 已启动：${startup.bff.origin}（双租户独立 Cell；Ctrl+C 关闭）`);
    if (!gateway.upstream.apiKey) console.warn("上游模型 key 未配置：编辑器可用，AI 请求将明确返回未配置错误，不会生成模拟内容。");
    return { close, failure, children, origin: startup.bff.origin };
  } catch (error) { await close().catch(() => undefined); throw error; }
}

async function main() {
  // Node's parser, not shell eval; .env is an explicit local developer configuration file.
  try { process.loadEnvFile(resolve(root, ".env")); } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const controller = new AbortController();
  let stop!: () => void;
  const stopped = new Promise<void>(done => { stop = () => { controller.abort(new DevelopmentStartupError("开发启动已取消")); done(); }; });
  // Register before startup: Ctrl+C during compilation/health checks must not orphan children.
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let application: Awaited<ReturnType<typeof startDevelopment>> | undefined;
  try {
    application = await startDevelopment(process.env, controller.signal);
    await Promise.race([stopped, application.failure]);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally {
    await application?.close();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof DevelopmentStartupError ? error.message : "Myrix 开发启动失败：请检查 setup:dev、前端构建及显式模型 URL/名称/上下文配置。未输出秘密。");
    process.exitCode = 1;
  });
}
