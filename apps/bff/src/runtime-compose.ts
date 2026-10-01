/**
 * 运行时装配例子（Lead 可直接照抄到进程入口）。
 *
 * 这个文件刻意**不做任何隐蔽的默认值**：
 *   * 依赖全部由参数传入（store / signer / directory / driver）；
 *   * 装配前先跑 `inspectRuntimeEnvironment`，把"cell 没装公钥 / kid 不匹配 /
 *     轮询租户不在目录里"这三类部署错误在启动时报出来；
 *   * 返回值里带 `dispatcher`，进程入口负责 `start()` 与进程退出时 `stop()`。
 *
 * 最小用法：
 *
 * ```ts
 * import pg from "pg";
 * import { createPlatformDatabase, createPlatformPool, PlatformStore, createGovernanceAuthorizer } from "@myrix/platform-store";
 * import { authorizePlatform } from "@myrix/governance";
 * import { readRuntimeEnvironment, createRuntimeSigner, inspectRuntimeEnvironment } from "./runtime-config";
 * import { createStaticCellDirectory } from "./runtime-cells";
 * import { createDriverHttpClient } from "./runtime-driver-client";
 * import { createRuntimeRouter } from "./runtime-router";
 * import { assembleRuntime } from "./runtime-compose";
 *
 * const env = readRuntimeEnvironment(process.env);
 * const pool = createPlatformPool({ connectionString: process.env.DATABASE_URL! });
 * const db = createPlatformDatabase(pool);
 * const store = new PlatformStore({
 *   db,
 *   authorizer: createGovernanceAuthorizer({ authorizePlatform }),
 *   serviceCapabilities: RUNTIME_SERVICE_CAPABILITIES,
 * });
 * const runtime = assembleRuntime({
 *   env,
 *   store,
 *   jwksByCell: JSON.parse(process.env.MYRIX_RUNTIME_JWKS_JSON!),
 * });
 * runtime.dispatcher.start();
 * const server = await createBffServer({ auth, repository, runtime });
 * ```
 *
 * 注意：`RUNTIME_SERVICE_CAPABILITIES` 必须**同时**授予给这个 store。
 * 生产装配不应把命令投递能力和浏览器请求路径共用同一个 store 实例。
 */
import type { PlatformStore } from "@myrix/platform-store";
import { RUNTIME_SERVICE_CAPABILITIES, createRuntimeRouter, type RuntimeRuntime } from "./runtime-router";
import { createStaticCellDirectory } from "./runtime-cells";
import { createDriverHttpClient, type DriverHttpClient, type DriverHttpClientOptions } from "./runtime-driver-client";
import { createRuntimeSigner, inspectRuntimeEnvironment, type RuntimeEnvironment } from "./runtime-config";
import type { GrantPublicJwk } from "@myrix/grant";
import type { RuntimeLogger } from "./runtime-log";

export interface AssembleRuntimeInput {
  env: RuntimeEnvironment;
  store: PlatformStore;
  /** 每个 cell 已安装的验签公钥（部署事实，用于启动期一致性检查）。 */
  jwksByCell?: Readonly<Record<string, readonly GrantPublicJwk[]>>;
  /** 注入 driver 客户端（测试/自定义超时）；缺省按 env 构造。 */
  driver?: DriverHttpClient;
  driverOptions?: DriverHttpClientOptions;
  logger?: RuntimeLogger;
  clock?: () => Date;
  signerClock?: () => number;
  /** 装配期检查发现问题的处置：`throw`（默认）或 `warn`。 */
  onInspectionProblem?: "throw" | "warn";
}

export function assembleRuntime(input: AssembleRuntimeInput): RuntimeRuntime {
  const logger = input.logger;
  const problems = inspectRuntimeEnvironment(input.env, input.jwksByCell ?? {});
  if (problems.length > 0) {
    if (input.onInspectionProblem === "warn") {
      for (const problem of problems) logger?.warn?.("myrix-bff runtime: 装配检查发现部署问题", { problem });
    } else {
      throw new Error(`myrix-bff runtime: 装配检查失败：${problems.join("；")}`);
    }
  }
  const directory = createStaticCellDirectory(input.env.cells, { ...(logger === undefined ? {} : { logger }) });
  const driver = input.driver ?? createDriverHttpClient({
    ...input.driverOptions,
    ...(logger === undefined ? {} : { logger }),
  });
  const signer = createRuntimeSigner(input.env, input.signerClock === undefined ? {} : { clock: input.signerClock });
  return createRuntimeRouter({
    store: input.store,
    signer,
    directory,
    driver,
    ...(logger === undefined ? {} : { logger }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.env.workerId === undefined ? {} : { workerId: input.env.workerId }),
    ...(input.env.leaseMs === undefined ? {} : { leaseMs: input.env.leaseMs }),
    ...(input.env.claimBatch === undefined ? {} : { claimBatch: input.env.claimBatch }),
    ...(input.env.revalidateMs === undefined ? {} : { revalidateMs: input.env.revalidateMs }),
    ...(input.env.tenantIds === undefined ? {} : { tenantIds: input.env.tenantIds }),
    ...(input.env.outboxEnabled === undefined ? {} : { outboxEnabled: input.env.outboxEnabled }),
  });
}

export { RUNTIME_SERVICE_CAPABILITIES };
