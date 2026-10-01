/**
 * 测试专用导出（`@myrix/platform-store/testing`）。
 *
 * **不在生产入口导出**：`createTestAuthorizer` 这类"显式放行若干动作"的替身
 * 一旦混进生产装配路径，就等于把 fail-closed 换成了一张白名单。
 * 这里用独立的 exports 子路径 + 目录名，让误用至少在代码评审里显眼。
 */

import type { Authorizer, PlatformDecision } from "../authz";

export interface TestAuthorizerOptions {
  /** 显式放行的动作；**其余一律拒绝**（与 fail-closed 语义一致） */
  allow?: readonly string[];
  reason?: string;
  /** 记录每次判定，便于断言"确实问了 authorizer" */
  log?: Array<{ action: string; effect: "allow" | "deny" }>;
}

/**
 * 测试替身：只放行 `options.allow` 列出的动作，其余默认拒绝。
 * 仅用于单元测试；需要对真实治理行为做断言时请直接绑定 `@myrix/governance`。
 */
export function createTestAuthorizer(options: TestAuthorizerOptions = {}): Authorizer {
  const allow = new Set(options.allow ?? []);
  return (request): PlatformDecision => {
    const effect = allow.has(request.action) ? "allow" : "deny";
    options.log?.push({ action: request.action, effect });
    return effect === "allow"
      ? {
          effect: "allow",
          reason: options.reason ?? `test-authorizer: 测试显式放行 ${request.action}`,
        }
      : {
          effect: "deny",
          reason: `test-authorizer: ${request.action} 未被测试显式放行，按默认拒绝`,
        };
  };
}

/**
 * 把 `@myrix/governance` 的真实 `authorizePlatform` 绑成 Authorizer 的便捷函数。
 * 与生产入口的 `createGovernanceAuthorizer` 是同一个实现，这里再导出一次是为了
 * 让测试只 import 一个路径。
 */
export { createGovernanceAuthorizer, createDenyAllAuthorizer } from "../authz";

/**
 * 给"系统操作"用例用的装配辅助：列出一组能力。
 * 生产装配必须显式选择能力（见 PlatformStoreOptions.serviceCapabilities）。
 */
export { SERVICE_CAPABILITIES } from "../authz";
export type { ServiceCapability } from "../authz";
