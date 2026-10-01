/**
 * CLI/部署侧配置工厂：环境变量 → 运行时装配输入。
 *
 * 只做"显式读取 + fail-closed 校验"，不读文件、不建连接、不签发任何东西，
 * 因此可以在装配（`runtime-compose.ts`）之前单独测试。
 *
 * 关键约束：
 *   * Cell 目录**必须显式配置**：没有 placement 就拒绝启动，不猜测地址、不默认 localhost。
 *   * 签名私钥必须是 ES256（P-256）PKCS#8 PEM；其余算法一律构造期拒绝。
 *   * admin service token 允许缺省（= 未配置，driver 侧会对该类端点返回 503），
 *     但一旦配置就必须足够长，避免"用 `dev` 当共享密钥"。
 *   * 环境变量名里的 `_JSON` 都是结构化配置，解析失败立即抛错并带上变量名。
 */
import type { GrantPublicJwk, GrantSigner } from "@myrix/grant";
import { createGrantSigner, toPrivateKeyObject } from "@myrix/grant";
import type { StaticCellDirectoryEntry } from "./runtime-cells";
import type { RuntimeLogger } from "./runtime-log";

export interface RuntimeEnvironment {
  /** cell 目录：每租户一条（JSON 数组）。 */
  cells: StaticCellDirectoryEntry[];
  /** 控制面签名私钥（ES256 PKCS#8 PEM）。 */
  signingKeyPem: string;
  /** 轮转 id，写进凭证 header.kid；必须与 driver 侧安装的公钥 kid 一致。 */
  signingKid: string;
  /** 签发方 claim；默认 myrix-control-plane。 */
  issuer: string;
  /** 需要轮询的租户（可选；缺省用目录里的全部租户）。 */
  tenantIds?: string[];
  workerId?: string;
  leaseMs?: number;
  claimBatch?: number;
  revalidateMs?: number;
  outboxEnabled?: boolean;
}

export interface RuntimeEnvOptions {
  /** 环境变量前缀；默认 `MYRIX_RUNTIME_`。 */
  prefix?: string;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} 是必填配置，缺失即拒绝启动`);
  return value;
}

function parseJson<T>(env: NodeJS.ProcessEnv, name: string): T {
  const raw = requireValue(env, name);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} 不是合法 JSON`);
  }
}

function optionalInteger(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min}..${max} 之间`);
  return value;
}

function parseCells(env: NodeJS.ProcessEnv, name: string): StaticCellDirectoryEntry[] {
  const parsed = parseJson<unknown>(env, name);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${name} 必须是非空数组（至少一个租户的 placement）`);
  const seenTenants = new Set<string>();
  const seenCells = new Set<string>();
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${name}[${String(index)}] 必须是对象`);
    }
    const record = entry as Record<string, unknown>;
    const allowed = new Set(["tenantId", "cellId", "baseUrl", "serviceToken"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new Error(`${name}[${String(index)}] 含有未知字段 ${key}`);
    }
    const tenantId = record["tenantId"];
    const cellId = record["cellId"];
    const baseUrl = record["baseUrl"];
    const serviceToken = record["serviceToken"];
    if (typeof tenantId !== "string" || typeof cellId !== "string" || typeof baseUrl !== "string") {
      throw new Error(`${name}[${String(index)}] 需要字符串字段 tenantId/cellId/baseUrl`);
    }
    if (serviceToken !== undefined && typeof serviceToken !== "string") {
      throw new Error(`${name}[${String(index)}] 的 serviceToken 必须是字符串`);
    }
    // 一 Cell 一租户：配置解析阶段就拒绝重复，错误里只出现标识符、不含 serviceToken。
    if (seenTenants.has(tenantId)) throw new Error(`${name}[${String(index)}] 租户 ${tenantId} 出现了多次，违反一 Cell 一租户`);
    if (seenCells.has(cellId)) throw new Error(`${name}[${String(index)}] cell ${cellId} 被多个租户复用，违反一 Cell 一租户`);
    seenTenants.add(tenantId);
    seenCells.add(cellId);
    return {
      tenantId,
      cellId,
      baseUrl,
      ...(serviceToken === undefined ? {} : { serviceToken }),
    };
  });
}

/** 读取环境变量；任何缺失/非法都在这里失败（调用方不必再做二次校验）。 */
export function readRuntimeEnvironment(env: NodeJS.ProcessEnv, options: RuntimeEnvOptions = {}): RuntimeEnvironment {
  const prefix = options.prefix ?? "MYRIX_RUNTIME_";
  const name = (suffix: string): string => `${prefix}${suffix}`;
  const cells = parseCells(env, name("CELLS_JSON"));
  const signingKeyPem = requireValue(env, name("SIGNING_KEY_PEM"));
  const signingKid = requireValue(env, name("SIGNING_KID"));
  // 私钥必须能解析成 P-256：这里复用 grant 包自己的校验器，
  // 避免"配了一把 RSA 私钥、到第一次签发才失败"。
  toPrivateKeyObject(signingKeyPem, signingKid);
  const issuer = env[name("ISSUER")]?.trim() || "myrix-control-plane";
  const tenantIdsRaw = env[name("TENANT_IDS")];
  const workerId = env[name("WORKER_ID")];
  if (workerId !== undefined && workerId.length > 128) throw new Error(`${name("WORKER_ID")} 过长`);
  return {
    cells,
    signingKeyPem,
    signingKid,
    issuer,
    ...(tenantIdsRaw === undefined || tenantIdsRaw.trim() === ""
      ? {}
      : { tenantIds: tenantIdsRaw.split(",").map((item) => item.trim()).filter((item) => item.length > 0) }),
    ...(workerId === undefined || workerId === "" ? {} : { workerId }),
    ...(() => {
      const leaseMs = optionalInteger(env, name("LEASE_MS"), 1_000, 600_000);
      const claimBatch = optionalInteger(env, name("CLAIM_BATCH"), 1, 100);
      const revalidateMs = optionalInteger(env, name("REVALIDATE_MS"), 1_000, 300_000);
      return {
        ...(leaseMs === undefined ? {} : { leaseMs }),
        ...(claimBatch === undefined ? {} : { claimBatch }),
        ...(revalidateMs === undefined ? {} : { revalidateMs }),
      };
    })(),
    ...(env[name("OUTBOX_ENABLED")] === "false" ? { outboxEnabled: false } : {}),
  };
}

/**
 * 从配置构造签名器。公钥集合（JWKS）由**部署方**另行分发给 cell：
 * BFF 只负责用私钥签发，绝不把私钥写进日志或响应。
 */
export function createRuntimeSigner(config: RuntimeEnvironment, options: { clock?: () => number } = {}): GrantSigner {
  return createGrantSigner({
    privateKey: config.signingKeyPem,
    kid: config.signingKid,
    issuer: config.issuer,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

/** 装配前的完整性检查；返回可读的问题清单（空数组 = 可以启动）。 */
export function inspectRuntimeEnvironment(config: RuntimeEnvironment, jwksByCell: Readonly<Record<string, readonly GrantPublicJwk[]>>): string[] {
  const problems: string[] = [];
  const seenTenants = new Set<string>();
  const seenCells = new Set<string>();
  for (const cell of config.cells) {
    if (seenTenants.has(cell.tenantId)) problems.push(`租户 ${cell.tenantId} 在目录里出现了多次`);
    seenTenants.add(cell.tenantId);
    // 一 Cell 一租户是**授权边界**（cellId = 凭证 aud）：复用必须报出来，不能只报租户重复。
    if (seenCells.has(cell.cellId)) problems.push(`cell ${cell.cellId} 被多个租户复用，违反一 Cell 一租户`);
    seenCells.add(cell.cellId);
    const jwks = jwksByCell[cell.cellId];
    if (!jwks || jwks.length === 0) {
      problems.push(`cell ${cell.cellId} 没有安装任何验签公钥：控制面签发的凭证会在该 cell 全部被拒`);
      continue;
    }
    if (!jwks.some((key) => key.kid === config.signingKid)) {
      problems.push(`cell ${cell.cellId} 未安装当前 kid=${config.signingKid} 的公钥：签发出去的凭证无法验签`);
    }
  }
  if (config.tenantIds) {
    for (const tenantId of config.tenantIds) {
      if (!seenTenants.has(tenantId)) problems.push(`轮询租户 ${tenantId} 不在 cell 目录内，投递会一直失败`);
    }
  }
  return problems;
}

export interface RuntimeAssemblyLog {
  logger?: RuntimeLogger;
}
