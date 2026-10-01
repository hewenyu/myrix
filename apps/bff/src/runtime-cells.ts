/**
 * Cell 目录（placement directory）。
 *
 * BFF 只通过这里解析"某个租户的会话应该投递到哪个 cell"。解析失败**一律拒绝**：
 * 没有目录条目就没有地址、没有 cellId、也没有 service credential，
 * 此时既不能签发凭证（缺 `aud`），也不能调用 driver。
 *
 * 首版只提供**静态目录**（每租户一个地址 / cellId / serviceToken），因为
 * Cell 管理器写入 CRD 的装配仍未验收；动态目录（读 CRD 或控制面表）以后可以
 * 实现同一个 `CellDirectory` 接口替换，不必改路由与投递循环。
 *
 * 安全约束（**一 Cell 一租户**）：
 *   * 一个租户只能有一个 cell，一个 cell 也只能服务一个租户。任何重复都在构造期
 *     报错，而不是"后者覆盖前者"：否则同一个 cellId 会被两个租户共用，而 cellId
 *     就是凭证的 `aud`、也是租户隔离的边界 —— 复用等于把两个租户的会话投到同一个
 *     driver 上，`tid` 绑定形同虚设。
 *   * 地址必须是 http/https 且不含用户名/密码/查询串/片段 —— 地址里的凭据
 *     会被写进错误信息与日志，且让"到底用哪个凭据"变得不可审计。
 *   * serviceToken 只在内存里保存，不写日志、不出现在错误 reason 里。
 *
 * **目录是可注入的**：构造期校验只能约束 `createStaticCellDirectory` 自己。
 * 调用方（`runtime-router.ts`）在拿到 `resolve`/`byId` 的结果后必须**再核对**
 * `endpoint.tenantId === 请求的 tenantId`，本模块导出 `cellServesTenant` 作为
 * 两侧共用的判定，避免"换一个目录实现就悄悄绕过"。
 */
import type { RuntimeLogger } from "./runtime-log";

export interface CellEndpoint {
  /** 该 cell 服务的租户。 */
  readonly tenantId: string;
  /** cell id；等于授权凭证的 `aud`。 */
  readonly cellId: string;
  /** driver 的基地址，例如 `http://10.0.0.7:7801`；不带尾斜杠。 */
  readonly baseUrl: string;
  /** admin 端点（drain / revoke）的 service credential；缺省表示未配置。 */
  readonly serviceToken?: string;
}

export interface CellDirectory {
  /** 按租户解析 placement；`undefined` = 没有放置，调用方必须拒绝。 */
  resolve(tenantId: string): Promise<CellEndpoint | undefined>;
  /**
   * 按 cellId 解析（撤权 outbox 通知按 binding.cell_id 投递时用）。
   *
   * `expectedTenantId` 是**必填**的请求方租户：实现必须核对 cell 确实服务该租户，
   * 不匹配时返回 `undefined`。把租户核对放进接口，是为了让每个实现都绕不过
   * "一 Cell 一租户"，而不是只在静态实现的构造期检查。
   */
  byId(cellId: string, expectedTenantId: string): Promise<CellEndpoint | undefined>;
  /**
   * 已知的租户清单（投递循环用）。
   * 动态目录（读 CRD/控制面）可能无法廉价枚举，因此这是可选的：
   * 缺省时装配必须显式提供 `tenantIds`，否则投递循环不知道该轮询谁。
   */
  tenants?(): Promise<readonly string[]>;
}

export interface StaticCellDirectoryEntry {
  tenantId: string;
  cellId: string;
  baseUrl: string;
  serviceToken?: string;
}

/**
 * 一个 endpoint 是否真的服务于该租户。
 *
 * 目录是可注入的（`CellDirectory` 接口对实现开放），所以"一 Cell 一租户"不能只靠
 * 静态目录的构造期检查：**任何**取到 endpoint 的地方都要用它再核对一次请求的
 * tenantId。`undefined` endpoint 同样视为"没有 placement"（fail-closed）。
 */
export function cellServesTenant(endpoint: CellEndpoint | undefined, tenantId: string): endpoint is CellEndpoint {
  return endpoint !== undefined && typeof tenantId === "string" && tenantId.length > 0 && endpoint.tenantId === tenantId;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new Error(`myrix-bff runtime: cell 目录字段 ${field} 必须是非空短字符串`);
  }
  return value;
}

function normalizeBaseUrl(value: unknown, cellId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`myrix-bff runtime: cell ${cellId} 缺少 driver 地址`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`myrix-bff runtime: cell ${cellId} 的 driver 地址不是合法 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`myrix-bff runtime: cell ${cellId} 的 driver 地址必须是 http/https`);
  }
  if (url.username || url.password) {
    throw new Error(`myrix-bff runtime: cell ${cellId} 的 driver 地址不得内嵌用户名或密码`);
  }
  if (url.search || url.hash) {
    throw new Error(`myrix-bff runtime: cell ${cellId} 的 driver 地址不得带查询串或片段`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * 静态目录：构造期就把错误配置暴露出来（重复租户、重复 cell、非法地址、过短的 token），
 * 而不是等第一次投递才失败。
 *
 * **一 Cell 一租户**在构造期是硬约束：只要 cellId 出现第二次就拒绝启动，
 * 无论地址/凭据是否相同 —— 地址相同也依然是"两个租户共用一个 cell"，
 * 那正是这条规则要禁止的形态。
 */
export function createStaticCellDirectory(
  entries: readonly StaticCellDirectoryEntry[],
  options: { logger?: RuntimeLogger } = {},
): CellDirectory {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("myrix-bff runtime: 静态 cell 目录为空，拒绝启动（没有 placement 就无法投递任何会话）");
  }
  const byTenant = new Map<string, CellEndpoint>();
  const byCell = new Map<string, CellEndpoint>();
  for (const entry of entries) {
    const tenantId = requireIdentifier(entry?.tenantId, "tenantId");
    const cellId = requireIdentifier(entry?.cellId, "cellId");
    const baseUrl = normalizeBaseUrl(entry?.baseUrl, cellId);
    if (entry.serviceToken !== undefined && (typeof entry.serviceToken !== "string" || entry.serviceToken.length < 16)) {
      throw new Error(`myrix-bff runtime: cell ${cellId} 的 serviceToken 至少 16 个字符（缺省表示未配置 admin 凭据）`);
    }
    const endpoint: CellEndpoint = {
      tenantId,
      cellId,
      baseUrl,
      ...(entry.serviceToken === undefined ? {} : { serviceToken: entry.serviceToken }),
    };
    const existingTenant = byTenant.get(tenantId);
    if (existingTenant !== undefined) {
      throw new Error(
        `myrix-bff runtime: 一 Cell 一租户被破坏 —— 租户 ${tenantId} 在目录里出现了多个 cell（${existingTenant.cellId} 与 ${cellId}），拒绝启动`,
      );
    }
    const existingCell = byCell.get(cellId);
    if (existingCell !== undefined) {
      // 地址/凭据是否相同都不放行：同一个 cellId 出现在两条租户条目里，
      // 就意味着 cellId（= 凭证 aud，= 租户隔离边界）被复用。
      const detail = existingCell.tenantId === tenantId ? "同一租户重复条目" : `被租户 ${existingCell.tenantId} 与 ${tenantId} 复用`;
      throw new Error(`myrix-bff runtime: cell ${cellId} ${detail}，违反一 Cell 一租户，拒绝启动`);
    }
    byTenant.set(tenantId, endpoint);
    byCell.set(cellId, endpoint);
  }
  options.logger?.info?.("myrix-bff runtime: 静态 cell 目录已装配", {
    tenants: byTenant.size,
    cells: byCell.size,
    cellsWithoutServiceToken: [...byCell.values()].filter((cell) => cell.serviceToken === undefined).length,
  });
  return {
    async resolve(tenantId: string): Promise<CellEndpoint | undefined> {
      if (typeof tenantId !== "string" || tenantId.length === 0) return undefined;
      return byTenant.get(tenantId);
    },
    async byId(cellId: string, expectedTenantId: string): Promise<CellEndpoint | undefined> {
      if (typeof cellId !== "string" || cellId.length === 0) return undefined;
      const endpoint = byCell.get(cellId);
      // 目录是可注入的，所以"byId 拿到就返回"不够：必须核对它确实服务请求的租户。
      return cellServesTenant(endpoint, expectedTenantId) ? endpoint : undefined;
    },
    async tenants(): Promise<readonly string[]> {
      return [...byTenant.keys()];
    },
  };
}
