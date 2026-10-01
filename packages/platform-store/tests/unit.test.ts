import { describe, expect, it } from "vitest";

import { decideVersionedWrite, assertHashShape } from "../src/cas";
import { sha256Hex, stableStringify, hashJson, isUuid, randomId } from "../src/util";
import { sanitizeDetail } from "../src/repositories/audit";
import { sessionStatusForGovernance } from "../src/domain";
import { PlatformStoreError, errors } from "../src/errors";
import { PlatformStore } from "../src/store";
import { createDenyAllAuthorizer } from "../src/authz";

/** 纯函数测试：CAS 三态、哈希形状、审计 detail 白名单、错误序列化。 */

describe("CAS 三态（服务器算 hash + parent expectedVersion 才 duplicate）", () => {
  const text = "第一章：起风了";
  const incoming = sha256Hex(text);

  it("expectedVersion == 当前版本 → append 新版本", () => {
    const decision = decideVersionedWrite(
      { currentVersion: 2, currentParentVersion: 1, currentContentHash: sha256Hex("旧正文") },
      { expectedVersion: 2, incomingHash: incoming },
    );
    expect(decision).toMatchObject({ effect: "append", nextVersion: 3 });
  });

  it("parent == expectedVersion 且正文哈希相同 → duplicate（返回已有版本，不写新行）", () => {
    const decision = decideVersionedWrite(
      { currentVersion: 3, currentParentVersion: 2, currentContentHash: incoming },
      { expectedVersion: 2, incomingHash: incoming },
    );
    expect(decision).toMatchObject({ effect: "duplicate", version: 3 });
  });

  it("parent == expectedVersion 但正文不同 → conflict（不许静默覆盖）", () => {
    const decision = decideVersionedWrite(
      { currentVersion: 3, currentParentVersion: 2, currentContentHash: incoming },
      { expectedVersion: 2, incomingHash: sha256Hex("换了一个字") },
    );
    expect(decision.effect).toBe("conflict");
  });

  it("parent 不匹配 → conflict", () => {
    const decision = decideVersionedWrite(
      { currentVersion: 5, currentParentVersion: 4, currentContentHash: incoming },
      { expectedVersion: 3, incomingHash: incoming },
    );
    expect(decision.effect).toBe("conflict");
  });

  it("非法 expectedVersion → conflict（不抛异常，交给调用方统一处理）", () => {
    expect(
      decideVersionedWrite(
        { currentVersion: 0, currentParentVersion: null, currentContentHash: incoming },
        { expectedVersion: -1, incomingHash: incoming },
      ).effect,
    ).toBe("conflict");
  });

  it("哈希必须是 64 位小写 hex", () => {
    expect(() => assertHashShape("abc")).toThrow();
    expect(() => assertHashShape(sha256Hex("x"))).not.toThrow();
  });
});

describe("util", () => {
  it("stableStringify 对键序不敏感（同一逻辑内容同哈希）", () => {
    expect(hashJson({ a: 1, b: [2, 3] })).toBe(hashJson({ b: [2, 3], a: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("randomId 是 UUIDv4", () => {
    expect(isUuid(randomId())).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("审计 detail 白名单（不携带作品正文）", () => {
  it("丢弃正文类字段，截断长字符串", () => {
    const detail = sanitizeDetail({
      text: "这是一整章正文，绝不该进审计",
      body: { prompt: "..." },
      reason: "ok",
      longValue: "x".repeat(900),
      count: 3,
      nested: { chapterId: "c1" },
    });
    expect(detail["text"]).toBeUndefined();
    expect(detail["body"]).toBeUndefined();
    expect(detail["count"]).toBe(3);
    expect(String(detail["longValue"]).length).toBeLessThanOrEqual(501);
    expect(typeof detail["nested"]).toBe("string");
  });
});

describe("会话状态规范化（closed 一律拒绝）", () => {
  it("creating/active/revoked 可用，closed 返回 null", () => {
    expect(sessionStatusForGovernance("creating")).toBe("creating");
    expect(sessionStatusForGovernance("active")).toBe("active");
    expect(sessionStatusForGovernance("revoked")).toBe("revoked");
    expect(sessionStatusForGovernance("closed")).toBeNull();
  });
});

describe("错误序列化（HTTP 不泄漏 SQL/正文）", () => {
  it("toResponseBody 只带 code + reason", () => {
    const error = errors.forbidden("not-owner: 只有会话所有者能发命令");
    expect(error.httpStatus).toBe(403);
    expect(error.toResponseBody()).toEqual({ error: "forbidden", reason: "not-owner: 只有会话所有者能发命令" });
  });

  it("toStoreError 把未知错误折叠成 503，reason 不含原始 message", () => {
    const wrapped = PlatformStore.toStoreError(
      new Error('relation "works" does not exist at character 42'),
      "写入作品失败",
    );
    expect(wrapped).toBeInstanceOf(PlatformStoreError);
    expect(wrapped.code).toBe("storage_unavailable");
    expect(wrapped.toResponseBody().reason).toBe("写入作品失败");
    expect(wrapped.toResponseBody().reason).not.toContain("relation");
  });

  it("internal 错误同样只暴露固定 reason", () => {
    const error = errors.internal("服务端内部错误", new Error("duplicate key value violates unique constraint"));
    expect(error.toResponseBody()).toEqual({ error: "internal", reason: "服务端内部错误" });
  });
});

describe("系统能力：默认没有任何能力", () => {
  it("requireService 在未授予时拒绝，并说明浏览器不可调用", () => {
    const store = new PlatformStore({ db: {} as never, authorizer: createDenyAllAuthorizer() });
    expect(store.hasService("audit.write")).toBe(false);
    expect(() => store.requireService("audit.write", "audit.write")).toThrow(/service-capability-missing/);
  });

  it("显式授予后放行", () => {
    const store = new PlatformStore({
      db: {} as never,
      serviceCapabilities: ["audit.write"],
    });
    expect(store.hasService("audit.write")).toBe(true);
    expect(() => store.requireService("audit.write", "audit.write")).not.toThrow();
    expect(() => store.requireService("command.claim", "commands.claim")).toThrow();
  });
});
