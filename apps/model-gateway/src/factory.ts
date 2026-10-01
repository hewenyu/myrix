/**
 * 装配工厂：把配置 + 端口（AuthorizerPort / LedgerPort / UpstreamClient）拼成可运行的网关。
 *
 * 协议：上游只走 OpenAI **Responses**（完整 `/responses` URL）；工厂不提供任何
 * chat/completions 装配分支。
 *
 * 注入优先级（Lead 接入时用第一种）：
 *   1. `authorizer`：已经组装好的 `Authorizer`（推荐，业务 store 自己实现）；
 *   2. `authorizerPort`：只实现三个读取方法，由本工厂套上 `createAuthorizer`（复用治理纯函数）；
 *   3. 都不给：仅当 `config.credentialSource === "env"` 时用内存凭据表（开发/联调），
 *      生产必须显式注入 —— 缺失即抛错，不做任何隐式回退。
 */
import { createAuthorizer, MemoryAuthorizerStore } from "./authorize";
import { resolveGatewayConfig, type GatewayConfig, type GatewayConfigOverrides } from "./config";
import { createDeepSeekUpstream, type UpstreamClient } from "./upstream";
import { MemoryLedger, type LedgerClock, type LedgerPort } from "./ledger";
import { ModelGateway, type AuditSink } from "./gateway";
import type { Authorizer, AuthorizerPort } from "./ports";

export interface GatewayRuntimeOptions {
  config?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
  overrides?: GatewayConfigOverrides;
  authorizer?: Authorizer;
  authorizerPort?: AuthorizerPort;
  ledger?: LedgerPort;
  upstream?: UpstreamClient;
  audit?: AuditSink;
  now?: () => number;
  clock?: LedgerClock;
  fetchImpl?: typeof fetch;
}

export interface GatewayRuntime {
  config: GatewayConfig;
  gateway: ModelGateway;
  authorizer: Authorizer;
  ledger: LedgerPort;
  upstream: UpstreamClient;
  /** 装配诊断（不含密钥），启动时打印一次 */
  diagnostics: {
    upstreamUrl: string;
    upstreamConfigured: boolean;
    models: readonly string[];
    credentialSource: "port" | "env";
    ledger: "injected" | "memory";
  };
}

export function createGatewayRuntime(options: GatewayRuntimeOptions = {}): GatewayRuntime {
  const config = options.config ?? resolveGatewayConfig(options.env ?? process.env, options.overrides ?? {});

  const upstream =
    options.upstream ??
    createDeepSeekUpstream({
      url: config.upstream.url,
      model: config.upstream.model,
      ...(config.upstream.apiKey === undefined ? {} : { apiKey: config.upstream.apiKey }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const ledger = options.ledger ?? new MemoryLedger({ ...(options.clock === undefined ? {} : { clock: options.clock }) });

  let authorizer = options.authorizer;
  if (!authorizer) {
    if (options.authorizerPort) {
      authorizer = createAuthorizer(options.authorizerPort);
    } else if (config.credentialSource === "env") {
      authorizer = createAuthorizer(
        new MemoryAuthorizerStore({ credentials: config.envCredentials }),
      );
    } else {
      throw new Error(
        "模型网关缺少 AuthorizerPort：生产必须注入业务 store 的绑定/成员读取实现（MYRIX_GATEWAY_CREDENTIAL_SOURCE=env 只用于开发）",
      );
    }
  }

  const gateway = new ModelGateway({
    config,
    authorizer,
    ledger,
    upstream,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    config,
    gateway,
    authorizer,
    ledger,
    upstream,
    diagnostics: {
      upstreamUrl: config.upstream.url,
      upstreamConfigured: upstream.configured,
      models: gateway.allowlist.entries,
      credentialSource: config.credentialSource,
      ledger: options.ledger ? "injected" : "memory",
    },
  };
}
