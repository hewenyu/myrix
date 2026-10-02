import { describe, expect, it } from "vitest";
import {
  GRANT_OPERATIONS,
  decodePayloadObject,
  encodeBase64Url,
  sha256Hex,
  type GrantClaimsJson,
} from "../src/index";
import {
  ISSUER,
  NOW,
  OTHER_BODY_HASH,
  OTHER_BOOT,
  baseClaims,
  binding,
  claimWith,
  createHarness,
  expectCode,
  mintToken,
  signRawPayload,
} from "./helpers";

/**
 * claim 负例表：每一行只改一个 claim，其余保持合法。
 * 断言的是“必须被拒绝 + 稳定错误码”，不锁死文案。
 */
interface ClaimCase {
  claim: string;
  bad: unknown;
  code: string;
}

const CLAIM_CASES: readonly ClaimCase[] = [
  { claim: "iss", bad: "myrix-someone-else", code: "grant/invalid-claims" },
  { claim: "iss", bad: undefined, code: "grant/invalid-claims" },
  { claim: "aud", bad: "cell-u_2", code: "grant/audience-mismatch" },
  { claim: "aud", bad: undefined, code: "grant/invalid-claims" },
  { claim: "boot", bad: OTHER_BOOT, code: "grant/boot-mismatch" },
  { claim: "boot", bad: "", code: "grant/invalid-claims" },
  { claim: "tid", bad: "t_other", code: "grant/tenant-mismatch" },
  { claim: "tid", bad: 123, code: "grant/invalid-claims" },
  { claim: "sid", bad: "", code: "grant/invalid-claims" },
  { claim: "sid", bad: "sid.1", code: "grant/invalid-claims" },
  { claim: "sid", bad: "a".repeat(129), code: "grant/invalid-claims" },
  { claim: "sub", bad: "u_1001 with space", code: "grant/invalid-claims" },
  { claim: "sub", bad: "sub.1", code: "grant/invalid-claims" },
  { claim: "wid", bad: "w.1", code: "grant/invalid-claims" },
  { claim: "preset", bad: "", code: "grant/invalid-claims" },
  { claim: "preset", bad: { id: "novel-chapter" }, code: "grant/invalid-claims" },
  { claim: "rev", bad: -1, code: "grant/invalid-claims" },
  { claim: "rev", bad: 1.5, code: "grant/invalid-claims" },
  { claim: "rev", bad: "7", code: "grant/invalid-claims" },
  { claim: "op", bad: "delete", code: "grant/invalid-claims" },
  { claim: "op", bad: undefined, code: "grant/invalid-claims" },
  { claim: "op", bad: ["send"], code: "grant/invalid-claims" },
  { claim: "cmd", bad: "", code: "grant/invalid-claims" },
  { claim: "cmd", bad: "cmd.1", code: "grant/invalid-claims" },
  { claim: "cmd", bad: "cmd\u0000", code: "grant/invalid-claims" },
  { claim: "bh", bad: "not-a-hash", code: "grant/invalid-claims" },
  { claim: "bh", bad: sha256Hex("x").toUpperCase(), code: "grant/invalid-claims" },
  { claim: "bh", bad: OTHER_BODY_HASH, code: "grant/body-hash-mismatch" },
  { claim: "jti", bad: "", code: "grant/invalid-claims" },
  { claim: "jti", bad: "jti.1", code: "grant/invalid-claims" },
  { claim: "iat", bad: -1, code: "grant/invalid-claims" },
  { claim: "iat", bad: 1_790_000_000.5, code: "grant/invalid-claims" },
  { claim: "iat", bad: NOW + 60, code: "grant/invalid-claims" },
  { claim: "exp", bad: "1790000060", code: "grant/invalid-claims" },
  { claim: "exp", bad: NOW, code: "grant/invalid-claims" },
  { claim: "exp", bad: NOW - 10, code: "grant/invalid-claims" },
];

describe("claim 约束（每个 claim 的错误取值都必须被拒）", () => {
  for (const { claim, bad, code } of CLAIM_CASES) {
    const label = bad === undefined ? "缺失" : JSON.stringify(bad);
    it(`${claim}=${label} → ${code}`, () => {
      const harness = createHarness();
      const payload = claimWith(claim, bad);
      const token = mintToken(payload);
      expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), code);
    });
  }

  it("合法凭证正常通过，并返回全部声明", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const claims = harness.verifier.verifyAndConsume(issued.token, harness.binding);
    expect(claims).toEqual(issued.claims);
    expect(Object.isFrozen(claims)).toBe(true);
  });

  it("未知 claim 被忽略（前向兼容），不导致拒绝", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const payload = { ...issued.claims, futureClaim: "x" } as GrantClaimsJson;
    const token = mintToken(payload);
    expect(() => harness.verifier.verifyAndConsume(token, harness.binding)).not.toThrow();
  });

  it("所有允许的 op 都能通过 op 绑定", () => {
    for (const op of GRANT_OPERATIONS) {
      const harness = createHarness();
      const issued = harness.issue({ op });
      expect(() => harness.verifier.verifyAndConsume(issued.token, binding({ op }))).not.toThrow();
    }
  });

  it("绑定侧的非法入参直接拒绝，不进入验签", () => {
    const harness = createHarness();
    const issued = harness.issue();
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ op: "delete" as never })),
      "grant/invalid-claims",
    );
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ cmd: "" })),
      "grant/invalid-claims",
    );
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ bh: "short" })),
      "grant/invalid-claims",
    );
  });
});

describe("绑定一致性（op / cmd / bh / aud / tid / boot）", () => {
  it("op 与本次请求不符 → 拒绝", () => {
    const harness = createHarness();
    const issued = harness.issue({ op: "send" });
    expectCode(() => harness.verifier.verifyAndConsume(issued.token, binding({ op: "cancel" })), "grant/operation-mismatch");
  });

  it("cmd 与本次请求不符 → 拒绝", () => {
    const harness = createHarness();
    const issued = harness.issue({ cmd: "cmd-1" });
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ cmd: "cmd-2" })),
      "grant/operation-mismatch",
    );
  });

  it("bh 与请求正文摘要不符 → 拒绝（凭证不能换一条消息）", () => {
    const harness = createHarness();
    const issued = harness.issue({ rawBody: "正文 A" });
    expectCode(
      () => harness.verifier.verifyAndConsume(issued.token, binding({ bh: sha256Hex("正文 B") })),
      "grant/body-hash-mismatch",
    );
  });

  it("aud/tid/boot 默认取校验器配置；配置不同即拒绝", () => {
    const harness = createHarness();
    const issued = harness.issue();

    const otherAudience = createHarness({ audience: "cell-u_9" });
    expectCode(
      () => otherAudience.verifier.verifyAndConsume(issued.token, otherAudience.binding),
      "grant/audience-mismatch",
    );

    const otherTenant = createHarness({ tenantId: "t_other" });
    expectCode(
      () => otherTenant.verifier.verifyAndConsume(issued.token, otherTenant.binding),
      "grant/tenant-mismatch",
    );

    const otherBoot = createHarness({ bootId: OTHER_BOOT });
    expectCode(
      () => otherBoot.verifier.verifyAndConsume(issued.token, otherBoot.binding),
      "grant/boot-mismatch",
    );
  });

  it("iss 必须与配置的签发方一致", () => {
    const harness = createHarness({ issuer: ISSUER });
    const token = mintToken(baseClaims({ iss: "myrix-control-plane-evil" }));
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/invalid-claims");
  });
});

describe("正文摘要绑定", () => {
  it("正文只以摘要进入凭证：token 里不出现正文", () => {
    const harness = createHarness();
    const secret = "机密正文-should-not-appear";
    const issued = harness.issue({ rawBody: secret });
    expect(issued.token).not.toContain(secret);
    expect(Buffer.from(issued.token.split(".")[1]!, "base64url").toString("utf8")).not.toContain(secret);
    expect(issued.claims.bh).toBe(sha256Hex(secret));
  });

  it("正文变一个字节，摘要就不同（防换消息）", () => {
    const harness = createHarness();
    const issued = harness.issue({ rawBody: '{"text":"a"}' });
    const tampered = sha256Hex('{"text":"b"}');
    expect(tampered).not.toBe(issued.claims.bh);
    expectCode(() => harness.verifier.verifyAndConsume(issued.token, binding({ bh: tampered })), "grant/body-hash-mismatch");
  });
});

describe("payload 编解码边界", () => {
  it("payload 不是 JSON 对象 → malformed（签名有效也一样拒绝）", () => {
    const harness = createHarness();
    const token = signRawPayload("[1,2,3]");
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/malformed");
  });

  it("payload 是 JSON null / 字符串 → malformed", () => {
    const harness = createHarness();
    for (const raw of ["null", '"abc"', "42"]) {
      expectCode(() => harness.verifier.verifyAndConsume(signRawPayload(raw), harness.binding), "grant/malformed");
    }
  });

  it("claim 值被换掉后即使重签也无法绕过类型约束（签名合法 ≠ 内容可信）", () => {
    const harness = createHarness();
    // 攻击者能看到明文 payload，但改任何一个字节都会破坏签名。
    const issued = harness.issue();
    const [h, , s] = issued.token.split(".");
    const tampered = encodeBase64Url(Buffer.from(JSON.stringify({ ...issued.claims, sub: "u_9999" }), "utf8"));
    const decoded = decodePayloadObject(Buffer.from(tampered, "base64url"));
    expect(decoded["sub"]).toBe("u_9999");
    expectCode(() => harness.verifier.verifyAndConsume(`${h}.${tampered}.${s}`, harness.binding), "grant/bad-signature");
  });
});
