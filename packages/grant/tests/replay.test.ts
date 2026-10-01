import { describe, expect, it } from "vitest";
import { createJtiStore, createManualClock } from "../src/index";
import { NOW, baseClaims, binding, createHarness, expectCode, mintToken } from "./helpers";

describe("一次性 jti（防重放）", () => {
  it("同一 token 第二次提交 → grant/replayed", () => {
    const harness = createHarness();
    const issued = harness.issue();
    expect(() => harness.verifier.verifyAndConsume(issued.token, harness.binding)).not.toThrow();
    expectCode(() => harness.verifier.verifyAndConsume(issued.token, harness.binding), "grant/replayed");
  });

  it("重试规则：同一 cmd 重新签发的新 jti 可以再次通过", () => {
    const harness = createHarness();
    const first = harness.issue();
    const retry = harness.issue(); // 同 cmd、同正文、新 jti
    expect(retry.claims.cmd).toBe(first.claims.cmd);
    expect(retry.claims.jti).not.toBe(first.claims.jti);

    expect(() => harness.verifier.verifyAndConsume(first.token, harness.binding)).not.toThrow();
    expect(() => harness.verifier.verifyAndConsume(retry.token, harness.binding)).not.toThrow();
  });

  it("伪造者拿合法 jti 但改签名 → bad-signature；且原凭证之后仍可用（失败不消费）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const [h, p] = issued.token.split(".");
    const forged = `${h}.${p}.${Buffer.alloc(64, 1).toString("base64url")}`;
    expectCode(() => harness.verifier.verifyAndConsume(forged, harness.binding), "grant/bad-signature");
    // 关键：失败的尝试没有烧掉合法 jti。
    expect(() => harness.verifier.verifyAndConsume(issued.token, harness.binding)).not.toThrow();
  });

  it("签名合法但绑错 cmd 的凭证不会被消费（不会拖垮后续正确请求）", () => {
    const harness = createHarness();
    const issued = harness.issue({ cmd: "cmd-1" });
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ cmd: "cmd-2" })),
      "grant/operation-mismatch",
    );
    expect(() => harness.verifier.verifyAndConsume(issued.token, binding({ cmd: "cmd-1" }))).not.toThrow();
  });

  it("过期凭证被拒后不会消费 jti（把时钟拨回去仍可用，证明未写入）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    harness.clock.advance(120); // exp 已过
    expectCode(() => harness.verifier.verifyAndConsume(issued.token, harness.binding), "grant/expired");
    // 只用于证明“过期路径没消费 jti”；生产上过期凭证永远不会再被接受。
    harness.clock.set(NOW);
    expect(() => harness.verifier.verifyAndConsume(issued.token, harness.binding)).not.toThrow();
  });

  it("jti 记录会随 TTL 过期回收，不会无限增长", () => {
    const clock = createManualClock(NOW);
    const store = createJtiStore({ clock: clock.now, retentionSeconds: 120 });
    store.consume("a");
    store.consume("b");
    expect(store.size()).toBe(2);
    clock.advance(121);
    expect(store.size()).toBe(2); // 惰性清理，读取前 size 不主动变
    expect(store.has("a")).toBe(false);
    expect(store.size()).toBe(1);
    // 过期后同 jti 可以再次消费（进程内窗口已过，实际会被 exp 门槛拦住）。
    expect(() => store.consume("a")).not.toThrow();
    expect(store.stats().evicted).toBeGreaterThan(0);
  });

  it("jti 记录条数达到上限时拒绝消费，而不是覆盖旧记录", () => {
    const clock = createManualClock(NOW);
    const store = createJtiStore({ clock: clock.now, retentionSeconds: 600, maxEntries: 2 });
    store.consume("a");
    store.consume("b");
    expectCode(() => store.consume("c"), "grant/replayed");
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(true);
    expect(store.stats().rejectedFull).toBe(1);
  });

  it("重启后旧凭证被 iat 门槛拒掉（jti 表清空也不影响）", () => {
    const signerHarness = createHarness();
    const issued = signerHarness.issue();
    // 新进程：startedAt 晚于凭证 iat。
    const restarted = createHarness({ startedAt: NOW + 10 });
    restarted.clock.set(NOW + 10);
    expectCode(() => restarted.verifier.verifyAndConsume(issued.token, restarted.binding), "grant/too-old");
  });

  it("同一 jti 换个 cmd 重新签名也是重放（jti 与绑定无关，消费是全局的）", () => {
    const harness = createHarness();
    const first = harness.issue();
    expect(() => harness.verifier.verifyAndConsume(first.token, harness.binding)).not.toThrow();

    // 攻击者复用 jti 但换了正文/命令重新签（需要私钥；这里模拟控制面 bug）。
    const reused = mintToken({ ...baseClaims(), jti: first.claims.jti, cmd: "cmd-2" });
    expectCode(
      () => harness.verifier.verifyAndConsume(reused, binding({ cmd: "cmd-2" })),
      "grant/replayed",
    );
  });
});
