import type { MyrixContext } from "@myrix/dsh-shim";
import { EntitlementClient } from "./entitlement-client";
import { diffMask, toToolMask, type ToolOwnership } from "./tool-mask";

export const name = "myrix-entitlement";
export const inject = ["tools"];

export interface Config {
  controlPlaneUrl: string;
  token: string;
  principalId: string;
  /** pluginId → 工具名；由 profile 渲染时写入，运行时只读 */
  toolOwners: ToolOwnership[];
  /** 授权变更的轮询间隔；0 表示只在启动时拉取一次 */
  refreshIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * 功能裁剪 PEP：把"这个主体能用哪些插件"落成 DSH 的工具掩码。
 *
 * 为什么用掩码而不是删除 profile 里的插件行：
 * - profile 是部署产物，按人改 profile 成本高；掩码可以运行时热更新（授权变更即时生效）
 * - DSH 的 restrict 语义是交集，天然只能收紧，符合"治理只能收窄"的原则
 * - 需要彻底不加载敏感代码时，仍应通过 profile 渲染（见 packages/registry）连行一起裁掉
 */
export function apply(ctx: MyrixContext, config: Config): void {
  const client = new EntitlementClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
  let previous = undefined as ReturnType<typeof toToolMask>;

  const sync = async (): Promise<void> => {
    try {
      const entitlement = await client.fetchFor(config.principalId);
      const mask = toToolMask(entitlement.enabled, config.toolOwners);
      if (mask === undefined) {
        ctx.logger?.warn("myrix-entitlement: 未提供 toolOwners，跳过工具掩码");
        return;
      }
      if (ctx.tools.restrict) {
        ctx.tools.restrict(mask);
        const changed = diffMask(previous, mask);
        previous = mask;
        ctx.logger?.info("myrix-entitlement: 已应用工具掩码", {
          allow: mask.allow.length,
          deny: mask.deny.length,
          added: changed.added,
          removed: changed.removed,
        });
      }
    } catch (error) {
      // 拉取失败不放宽：保持上一次掩码（首次失败则不施加任何额外权限，由治理插件兜底拒绝）
      ctx.logger?.warn("myrix-entitlement: 授权拉取失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void sync();
  const interval = config.refreshIntervalMs ?? 60_000;
  if (interval > 0) {
    const handle = setInterval(() => void sync(), interval);
    handle.unref?.();
  }
}
