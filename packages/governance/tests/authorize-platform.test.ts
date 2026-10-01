import { describe, expect, it } from "vitest";
import {
  PLATFORM_ACTIONS,
  authorizePlatform,
  type AuthorizePlatformInput,
  type PlatformMember,
} from "../src/index";

const TENANT = "acme";
const ALICE = "u_alice";
const BOB = "u_bob";
const CAROL = "u_carol";

function member(overrides: Partial<PlatformMember> = {}): PlatformMember {
  return { tenantId: TENANT, userId: ALICE, status: "active", role: "member", ...overrides };
}

function input(overrides: Partial<AuthorizePlatformInput> = {}): AuthorizePlatformInput {
  return {
    actor: { tenantId: TENANT, userId: ALICE },
    member: member(),
    action: "works:read",
    resource: { tenantId: TENANT, ownerUserId: ALICE, revision: 3 },
    expectedRevision: 3,
    ...overrides,
  };
}

/** 每个用例都断言 effect 与可读原因，避免"只有布尔值、出了事故看不懂" */
function expectDeny(result: { effect: string; reason: string }, keyword?: string): void {
  expect(result.effect).toBe("deny");
  expect(result.reason.startsWith("拒绝：")).toBe(true);
  expect(result.reason.length).toBeGreaterThan(6);
  if (keyword !== undefined) expect(result.reason).toContain(keyword);
}

function expectAllow(result: { effect: string; reason: string }): void {
  expect(result.effect).toBe("allow");
  expect(result.reason.startsWith("允许：")).toBe(true);
  expect(result.reason.length).toBeGreaterThan(6);
}

describe("authorizePlatform：正常路径", () => {
  it("成员读写自己的作品、章节、设定、大纲", () => {
    for (const action of [
      "works:read",
      "works:update",
      "works:delete",
      "chapters:read",
      "chapters:write",
      "bible:read",
      "bible:write",
      "outline:read",
      "outline:write",
    ]) {
      expectAllow(authorizePlatform(input({ action })));
    }
  });

  it("成员列举与创建作品、列举会话、调用模型", () => {
    expectAllow(authorizePlatform(input({ action: "works:list", resource: undefined, expectedRevision: undefined })));
    expectAllow(authorizePlatform(input({ action: "works:create", resource: undefined, expectedRevision: undefined })));
    expectAllow(authorizePlatform(input({ action: "sessions:list", resource: undefined, expectedRevision: undefined })));
    expectAllow(authorizePlatform(input({ action: "models:invoke", resource: undefined, expectedRevision: undefined })));
  });

  it("成员在自己的作品上创建会话（资源所有者是自己）", () => {
    expectAllow(
      authorizePlatform(
        input({
          action: "sessions:create",
          resource: { tenantId: TENANT, ownerUserId: ALICE },
          expectedRevision: undefined,
        }),
      ),
    );
  });

  it("创建会话必须指名自己拥有的作品，不能只凭成员身份", () => {
    expectDeny(
      authorizePlatform(input({ action: "sessions:create", resource: undefined, expectedRevision: undefined })),
      "必须指定目标资源",
    );
  });

  it("成员操作自己的活动会话（状态 active + 版本一致）", () => {
    for (const action of [
      "sessions:read",
      "sessions:send",
      "sessions:resume",
      "sessions:cancel",
      "sessions:subscribe",
      "sessions:revoke",
    ]) {
      expectAllow(
        authorizePlatform(
          input({
            action,
            resource: { tenantId: TENANT, ownerUserId: ALICE, status: "active", revision: 7 },
            expectedRevision: 7,
          }),
        ),
      );
    }
  });

  it("管理员可停用成员、撤销任意会话、读审计", () => {
    const admin = member({ role: "admin" });
    expectAllow(
      authorizePlatform(
        input({
          member: admin,
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: BOB, role: "member", status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      ),
    );
    expectAllow(
      authorizePlatform(
        input({
          member: admin,
          action: "sessions:revoke",
          resource: { tenantId: TENANT, ownerUserId: BOB, status: "active", revision: 2 },
          expectedRevision: 2,
        }),
      ),
    );
    expectAllow(authorizePlatform(input({ member: admin, action: "audit:list", resource: undefined, expectedRevision: undefined })));
  });

  it("审计员只能读审计", () => {
    const auditor = member({ role: "auditor" });
    expectAllow(authorizePlatform(input({ member: auditor, action: "audit:list", resource: undefined, expectedRevision: undefined })));
    expectDeny(
      authorizePlatform(input({ member: auditor, action: "works:read" })),
      "白名单不包含",
    );
  });
});

describe("authorizePlatform：跨租户", () => {
  it("拒绝跨租户资源，即使所有者是本人", () => {
    expectDeny(
      authorizePlatform(
        input({ resource: { tenantId: "globex", ownerUserId: ALICE, revision: 3 } }),
      ),
      "跨租户访问",
    );
  });

  it("拒绝成员记录属于别的租户（同一 userId 也不行）", () => {
    expectDeny(
      authorizePlatform(input({ member: member({ tenantId: "globex" }) })),
      "成员不属于该租户",
    );
  });

  it("拒绝缺失资源租户", () => {
    expectDeny(
      authorizePlatform(input({ resource: { tenantId: "", ownerUserId: ALICE } })),
      "缺少 tenantId",
    );
  });
});

describe("authorizePlatform：同租户他人资源", () => {
  it("不能读、改、删别人的作品", () => {
    for (const action of ["works:read", "works:update", "works:delete"]) {
      expectDeny(
        authorizePlatform(input({ action, resource: { tenantId: TENANT, ownerUserId: BOB, revision: 3 } })),
        "非资源所有者",
      );
    }
  });

  it("不能读别人的章节 / 设定 / 大纲", () => {
    for (const action of ["chapters:read", "chapters:write", "bible:read", "outline:write"]) {
      expectDeny(
        authorizePlatform(
          input({ action, resource: { tenantId: TENANT, ownerUserId: BOB, revision: 3 } }),
        ),
        "非资源所有者",
      );
    }
  });

  it("创建会话不等于有访问别人作品的权利：成员不能在他人作品上建会话", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "sessions:create",
          resource: { tenantId: TENANT, ownerUserId: BOB },
          expectedRevision: undefined,
        }),
      ),
      "非资源所有者",
    );
  });

  it("不能读/发消息给别人的会话，且管理员也不能冒充", () => {
    for (const action of ["sessions:read", "sessions:send", "sessions:resume", "sessions:subscribe", "sessions:cancel"]) {
      expectDeny(
        authorizePlatform(
          input({
            action,
            resource: { tenantId: TENANT, ownerUserId: BOB, status: "active", revision: 5 },
            expectedRevision: 5,
          }),
        ),
        "非资源所有者",
      );
      // 管理员同样不能以他人身份进入会话内容
      expectDeny(
        authorizePlatform(
          input({
            member: member({ role: "admin" }),
            action,
            resource: { tenantId: TENANT, ownerUserId: BOB, status: "active", revision: 5 },
            expectedRevision: 5,
          }),
        ),
        "非资源所有者",
      );
    }
  });

  it("不能列举他人作品（请求 ownerUserId=他人）", () => {
    expectDeny(
      authorizePlatform(
        input({ action: "works:list", resource: { tenantId: TENANT, ownerUserId: BOB }, expectedRevision: undefined }),
      ),
      "只能作用于本人资源",
    );
  });

  it("模型调用不能归因到他人资源", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "models:invoke",
          resource: { tenantId: TENANT, ownerUserId: BOB },
          expectedRevision: undefined,
        }),
      ),
      "不能归因到他人资源",
    );
    expectAllow(
      authorizePlatform(
        input({
          action: "models:invoke",
          resource: { tenantId: TENANT, ownerUserId: ALICE },
          expectedRevision: undefined,
        }),
      ),
    );
  });

  it("成员不能停用成员（管理员专属）", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: BOB, role: "member", status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "白名单不包含",
    );
  });

  it("成员不能读审计", () => {
    expectDeny(
      authorizePlatform(input({ action: "audit:list", resource: undefined, expectedRevision: undefined })),
      "白名单不包含",
    );
  });
});

describe("authorizePlatform：身份与成员缺失", () => {
  it("缺失成员记录一律拒绝（fail-closed）", () => {
    expectDeny(authorizePlatform(input({ member: undefined })), "未知身份");
  });

  it("成员被禁用后拒绝所有动作", () => {
    expectDeny(
      authorizePlatform(input({ member: member({ status: "disabled" }) })),
      "只有 active 成员",
    );
    expectDeny(
      authorizePlatform(
        input({
          member: member({ status: "disabled", role: "admin" }),
          action: "audit:list",
          resource: undefined,
          expectedRevision: undefined,
        }),
      ),
      "只有 active 成员",
    );
  });

  it("未知成员状态按拒绝处理", () => {
    expectDeny(
      authorizePlatform(input({ member: member({ status: "pending" as never }) })),
      "只有 active 成员",
    );
  });

  it("缺失或未知角色一律拒绝", () => {
    expectDeny(
      authorizePlatform(input({ member: member({ role: undefined as never }) })),
      "未知成员角色",
    );
    expectDeny(
      authorizePlatform(input({ member: member({ role: "superuser" as never }) })),
      "未知成员角色",
    );
  });

  it("成员记录与执行主体不一致（疑似冒充）拒绝", () => {
    expectDeny(
      authorizePlatform(input({ actor: { tenantId: TENANT, userId: ALICE }, member: member({ userId: BOB }) })),
      "疑似冒充他人",
    );
  });

  it("执行主体缺失 tenantId/userId 拒绝", () => {
    expectDeny(
      authorizePlatform(input({ actor: { tenantId: "", userId: ALICE } })),
      "缺少 tenantId/userId",
    );
    expectDeny(
      authorizePlatform(input({ actor: { tenantId: TENANT, userId: "" } })),
      "缺少 tenantId/userId",
    );
  });

  it("资源缺失所有者也拒绝，不默认放行", () => {
    expectDeny(
      authorizePlatform(input({ resource: { tenantId: TENANT, revision: 3 } })),
      "必须提供资源所有者",
    );
  });
});

describe("authorizePlatform：撤权与版本", () => {
  it("会话已撤销时拒绝所有会话操作", () => {
    for (const action of ["sessions:read", "sessions:send", "sessions:resume", "sessions:cancel", "sessions:subscribe", "sessions:revoke"]) {
      expectDeny(
        authorizePlatform(
          input({
            action,
            resource: { tenantId: TENANT, ownerUserId: ALICE, status: "revoked", revision: 9 },
            expectedRevision: 9,
          }),
        ),
        "已撤销",
      );
    }
  });

  it("撤权版本不匹配时拒绝（所有权正确也不放行）", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "sessions:send",
          resource: { tenantId: TENANT, ownerUserId: ALICE, status: "active", revision: 9 },
          expectedRevision: 8,
        }),
      ),
      "撤权版本不匹配",
    );
  });

  it("会话操作缺少 expectedRevision 拒绝", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "sessions:send",
          resource: { tenantId: TENANT, ownerUserId: ALICE, status: "active", revision: 9 },
          expectedRevision: undefined,
        }),
      ),
      "必须提供 expectedRevision",
    );
  });

  it("缺少会话状态或状态未知拒绝", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "sessions:read",
          resource: { tenantId: TENANT, ownerUserId: ALICE, revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "必须提供会话状态",
    );
    expectDeny(
      authorizePlatform(
        input({
          action: "sessions:read",
          resource: { tenantId: TENANT, ownerUserId: ALICE, status: "archived", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "未知会话状态",
    );
  });

  it("资源缺少 revision 但调用方给了 expectedRevision，拒绝而不是忽略", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "works:update",
          resource: { tenantId: TENANT, ownerUserId: ALICE },
          expectedRevision: 3,
        }),
      ),
      "缺少 revision",
    );
  });

  it("expectedRevision 非法（负数/小数）拒绝", () => {
    expectDeny(authorizePlatform(input({ expectedRevision: -1 })), "expectedRevision 非法");
    expectDeny(authorizePlatform(input({ expectedRevision: 1.5 })), "expectedRevision 非法");
  });
});

describe("authorizePlatform：未知输入", () => {
  it("未知 action 一律拒绝，且不误判为成功", () => {
    for (const action of ["", "works:publish", "sessions:impersonate", "admin:*", "*", "works:read:any"]) {
      expectDeny(authorizePlatform(input({ action })), "未知操作");
    }
  });

  it("动作清单是显式 allowlist：每个动作都必须能判定出原因", () => {
    expect(PLATFORM_ACTIONS.length).toBeGreaterThan(0);
    for (const action of PLATFORM_ACTIONS) {
      const result = authorizePlatform(
        input({
          action,
          resource: { tenantId: TENANT, ownerUserId: ALICE, status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      );
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.effect === "allow" || result.effect === "deny").toBe(true);
    }
  });

  it("未知成员角色、未知目标角色、未知成员状态都拒绝", () => {
    expectDeny(
      authorizePlatform(
        input({
          member: member({ role: "admin" }),
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: BOB, role: "owner", status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "未知角色",
    );
    expectDeny(
      authorizePlatform(
        input({
          member: member({ role: "admin" }),
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: BOB, role: "member", status: "removed", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "已被移除",
    );
    expectDeny(
      authorizePlatform(
        input({
          member: member({ role: "admin" }),
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: BOB, role: "member", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "必须提供目标成员当前状态",
    );
  });

  it("actions 不支持 status 字段时拒绝，不静默忽略", () => {
    expectDeny(
      authorizePlatform(
        input({
          action: "works:read",
          resource: { tenantId: TENANT, ownerUserId: ALICE, status: "active", revision: 3 },
        }),
      ),
      "不支持在资源上携带 status",
    );
  });
});

describe("authorizePlatform：管理员边界", () => {
  it("管理员不能停用自己（避免自锁）", () => {
    expectDeny(
      authorizePlatform(
        input({
          member: member({ role: "admin" }),
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: ALICE, role: "admin", status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "不能变更自己",
    );
  });

  it("管理员不能停用其他管理员（首版无 owner 角色）", () => {
    expectDeny(
      authorizePlatform(
        input({
          member: member({ role: "admin" }),
          action: "members:update",
          resource: { tenantId: TENANT, ownerUserId: CAROL, role: "admin", status: "active", revision: 1 },
          expectedRevision: 1,
        }),
      ),
      "不允许管理员停用其他管理员",
    );
  });

  it("members:update 的目标是成员状态，不是作品所有者：不能借此访问他人作品", () => {
    // 用 members:update 把 BOB 作为“所有者”传入，得到的是管理判定，不会产生任何内容访问
    const result = authorizePlatform(
      input({
        member: member({ role: "admin" }),
        action: "members:update",
        resource: { tenantId: TENANT, ownerUserId: BOB, role: "member", status: "active", revision: 1 },
        expectedRevision: 1,
      }),
    );
    expectAllow(result);
    expect(result.reason).toContain("不附带其作品或会话内容访问权");
  });

  it("管理员撤销他人会话的 reason 明确说明不读取会话内容", () => {
    const result = authorizePlatform(
      input({
        member: member({ role: "admin" }),
        action: "sessions:revoke",
        resource: { tenantId: TENANT, ownerUserId: BOB, status: "active", revision: 4 },
        expectedRevision: 4,
      }),
    );
    expectAllow(result);
    expect(result.reason).toContain("不读取会话内容");
  });
});
