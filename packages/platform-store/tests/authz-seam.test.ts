import { describe, expect, it } from "vitest";

import { createDenyAllAuthorizer, createGovernanceAuthorizer, isPlatformActionShape } from "../src/authz";
import { authorizePlatform, PLATFORM_ACTIONS } from "@myrix/governance";
import type { PlatformRequest } from "../src/authz";

/**
 * 接缝单测（不需要数据库）：
 *   1. 生产 authorizer 必须真的是 governance 的 `authorizePlatform`；
 *   2. platform-store 的动作名必须与 governance 完全一致（冒号 + 复数），不允许 dot 动作；
 *   3. member 记录必须作为**独立字段**逐字段映射，不能靠嵌套结构侥幸匹配；
 *   4. 默认（未绑定）必须全拒。
 */

const baseActor = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  tenantId: "7e000000-0000-4000-8000-000000000001",
  membership: { status: "active" as const, role: "member" as const },
};

function request(overrides: Partial<PlatformRequest> = {}): PlatformRequest {
  return {
    actor: baseActor,
    action: "works:read",
    resource: {
      kind: "work",
      tenantId: baseActor.tenantId,
      ownerUserId: baseActor.userId,
    },
    ...overrides,
  };
}

describe("authorizer seam", () => {
  it("未绑定 authorizer 时默认全拒，且拒绝原因说明未绑定", () => {
    const decision = createDenyAllAuthorizer()(request());
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("authorizer-not-bound");
  });

  it("createGovernanceAuthorizer 缺少 authorizePlatform 时构造期抛错（不静默放行/拒绝）", () => {
    expect(() => createGovernanceAuthorizer({})).toThrow(/authorizePlatform/);
  });

  it("生产绑定走真实 governance：本人作品放行，他人作品拒绝", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });

    const own = authorizer(request());
    expect(own.effect).toBe("allow");
    expect(own.reason).toContain("允许");

    const other = authorizer(
      request({
        resource: {
          kind: "work",
          tenantId: baseActor.tenantId,
          ownerUserId: "aaaaaaaa-0000-4000-8000-000000000099",
        },
      }),
    );
    expect(other.effect).toBe("deny");
    expect(other.reason).toContain("拒绝");
  });

  it("成员记录缺失（member undefined）时治理层按未知身份拒绝", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const decision = authorizer(request({ actor: { ...baseActor, membership: null } }));
    expect(decision.effect).toBe("deny");
  });

  it("成员被停用时拒绝（status 作为独立字段传给治理层）", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const decision = authorizer(
      request({ actor: { ...baseActor, membership: { status: "disabled", role: "member" } } }),
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("disabled");
  });

  it("跨租户资源拒绝", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const decision = authorizer(
      request({
        resource: { kind: "work", tenantId: "7e000000-0000-4000-8000-0000000000ff", ownerUserId: baseActor.userId },
      }),
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("跨租户");
  });

  it("会话动作必须同时给 status 与 expectedRevision；closed 不是治理状态", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });

    const missingRev = authorizer(
      request({
        action: "sessions:send",
        resource: {
          kind: "session_binding",
          tenantId: baseActor.tenantId,
          ownerUserId: baseActor.userId,
          status: "active",
        },
      }),
    );
    expect(missingRev.effect).toBe("deny");

    const ok = authorizer(
      request({
        action: "sessions:send",
        resource: {
          kind: "session_binding",
          tenantId: baseActor.tenantId,
          ownerUserId: baseActor.userId,
          status: "active",
          revision: 3,
        },
        expectedRevision: 3,
      }),
    );
    expect(ok.effect).toBe("allow");

    const stale = authorizer(
      request({
        action: "sessions:send",
        resource: {
          kind: "session_binding",
          tenantId: baseActor.tenantId,
          ownerUserId: baseActor.userId,
          status: "active",
          revision: 4,
        },
        expectedRevision: 3,
      }),
    );
    expect(stale.effect).toBe("deny");
    expect(stale.reason).toContain("撤权版本不匹配");

    // closed 不在 governance 的 SESSION_STATUSES 里，必须被拒绝
    const closed = authorizer(
      request({
        action: "sessions:read",
        resource: {
          kind: "session_binding",
          tenantId: baseActor.tenantId,
          ownerUserId: baseActor.userId,
          status: "closed",
          revision: 1,
        },
        expectedRevision: 1,
      }),
    );
    expect(closed.effect).toBe("deny");
  });

  it("平台动作名全部是 governance 的冒号复数动作（没有 dot 动作）", () => {
    for (const action of PLATFORM_ACTIONS) {
      expect(isPlatformActionShape(action)).toBe(true);
      expect(action).toContain(":");
      expect(action).not.toContain(".");
    }
    expect(PLATFORM_ACTIONS).toContain("members:update");
    expect(PLATFORM_ACTIONS).toContain("audit:list");
  });

  it("admin 不能读他人作品/会话内容，但可以 members:update 与 audit:list", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const admin = {
      userId: "aaaaaaaa-0000-4000-8000-000000000002",
      tenantId: baseActor.tenantId,
      membership: { status: "active" as const, role: "admin" as const },
    };
    const otherOwner = "aaaaaaaa-0000-4000-8000-000000000001";

    expect(
      authorizer({
        actor: admin,
        action: "works:read",
        resource: { kind: "work", tenantId: admin.tenantId, ownerUserId: otherOwner },
      }).effect,
    ).toBe("deny");

    expect(
      authorizer({
        actor: admin,
        action: "sessions:send",
        resource: {
          kind: "session_binding",
          tenantId: admin.tenantId,
          ownerUserId: otherOwner,
          status: "active",
          revision: 1,
        },
        expectedRevision: 1,
      }).effect,
    ).toBe("deny");

    // 管理员唯一能作用于他人资源的动作：撤销会话（不读取内容）
    expect(
      authorizer({
        actor: admin,
        action: "sessions:revoke",
        resource: {
          kind: "session_binding",
          tenantId: admin.tenantId,
          ownerUserId: otherOwner,
          status: "active",
          revision: 2,
        },
        expectedRevision: 2,
      }).effect,
    ).toBe("allow");

    expect(
      authorizer({
        actor: admin,
        action: "members:update",
        resource: {
          kind: "member",
          tenantId: admin.tenantId,
          ownerUserId: otherOwner,
          role: "member",
          status: "active",
        },
      }).effect,
    ).toBe("allow");

    expect(
      authorizer({ actor: admin, action: "audit:list", resource: { kind: "audit", tenantId: admin.tenantId } })
        .effect,
    ).toBe("allow");
  });

  it("auditor 只能读审计", () => {
    const authorizer = createGovernanceAuthorizer({ authorizePlatform });
    const auditor = {
      userId: "aaaaaaaa-0000-4000-8000-000000000003",
      tenantId: baseActor.tenantId,
      membership: { status: "active" as const, role: "auditor" as const },
    };
    expect(
      authorizer({ actor: auditor, action: "audit:list", resource: { kind: "audit", tenantId: auditor.tenantId } })
        .effect,
    ).toBe("allow");
    expect(
      authorizer({ actor: auditor, action: "works:list", resource: { kind: "work", tenantId: auditor.tenantId } })
        .effect,
    ).toBe("deny");
  });
});
