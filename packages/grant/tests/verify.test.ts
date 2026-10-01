import { describe, expect, it } from "vitest";
import { GRANT_TTL_SECONDS, createGrantVerifier, createManualClock, encodeBase64Url, generateTestKeyPair, sha256Hex } from "../src/index";
import {
  AUDIENCE,
  BOOT,
  BODY,
  BODY_HASH,
  ISSUER,
  NOW,
  TENANT,
  baseClaims,
  binding,
  createHarness,
  expectCode,
  keyCurrent,
  keyNext,
  keyRogue,
  mintToken,
} from "./helpers";

describe("时效（TTL 60s / 时钟偏差 / 启动门槛）", () => {
  it("59s 时仍有效，60s 起被拒（exp 半开区间）", () => {
    const harness = createHarness({ clockSkewSeconds: 0 });
    const issued = harness.issue();
    harness.clock.advance(GRANT_TTL_SECONDS - 1);
    expect(() => harness.verifier.verifyAndConsume(issued.token, harness.binding)).not.toThrow();

    const second = createHarness({ clockSkewSeconds: 0 });
    const issued2 = second.issue();
    second.clock.advance(GRANT_TTL_SECONDS);
    expectCode(() => second.verifier.verifyAndConsume(issued2.token, second.binding), "grant/expired");
  });

  it("时钟偏差内（≤5s）刚过期的凭证仍接受，超过则拒绝", () => {
    const skewed = createHarness({ clockSkewSeconds: 5 });
    const issued = skewed.issue();
    skewed.clock.advance(GRANT_TTL_SECONDS + 3);
    expect(() => skewed.verifier.verifyAndConsume(issued.token, skewed.binding)).not.toThrow();

    const other = createHarness({ clockSkewSeconds: 5 });
    const issued2 = other.issue();
    other.clock.advance(GRANT_TTL_SECONDS + 6);
    expectCode(() => other.verifier.verifyAndConsume(issued2.token, other.binding), "grant/expired");
  });

  it("iat 早于进程启动时刻 → too-old（重启后旧凭证一律拒绝）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const restarted = createHarness({ startedAt: NOW + 1 });
    restarted.clock.set(NOW + 1);
    expectCode(() => restarted.verifier.verifyAndConsume(issued.token, restarted.binding), "grant/too-old");
  });

  it("iat 恰好等于启动时刻 → 接受（边界含等号）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const sameStart = createHarness({ startedAt: issued.claims.iat });
    expect(() => sameStart.verifier.verifyAndConsume(issued.token, sameStart.binding)).not.toThrow();
  });

  it("iat 在未来（超出允许偏差）→ 拒绝", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims({ iat: NOW + 30, exp: NOW + 90 }));
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/invalid-claims");
  });

  it("有效期超过 60s 上限 → 拒绝（不能自行放宽 TTL）", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims({ iat: NOW, exp: NOW + 3600 }));
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/invalid-claims");
  });

  it("exp 早于或等于 iat → 拒绝（结构错误，先于过期判定）", () => {
    const harness = createHarness();
    expectCode(
      () => harness.verifier.verifyAndConsume(mintToken(baseClaims({ iat: NOW, exp: NOW })), harness.binding),
      "grant/invalid-claims",
    );
    expectCode(
      () => harness.verifier.verifyAndConsume(mintToken(baseClaims({ iat: NOW, exp: NOW - 5 })), harness.binding),
      "grant/invalid-claims",
    );
  });

  it("已经过期的凭证 → expired（TTL 合法但当前时间已越界）", () => {
    const harness = createHarness({ clockSkewSeconds: 0 });
    const issued = harness.issue();
    harness.clock.advance(GRANT_TTL_SECONDS);
    expectCode(() => harness.verifier.verifyAndConsume(issued.token, harness.binding), "grant/expired");
  });

  it("校验器拒绝超出上限的 maxTtlSeconds 配置", () => {
    expectCode(
      () =>
        createGrantVerifier({
          audience: AUDIENCE,
          tenantId: TENANT,
          bootId: BOOT,
          startedAt: NOW,
          issuer: ISSUER,
          keys: [keyNext.jwk],
          maxTtlSeconds: 120,
        }),
      "grant/signer-unavailable",
    );
  });
});

describe("签名与选钥", () => {
  it("换一把私钥签名（同 kid）→ bad-signature", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { privateKey: keyRogue.privateKey, kid: harness.signer.kid });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/bad-signature");
  });

  it("改了 payload 一个字节 → bad-signature（不是 invalid-claims）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const [h, , s] = issued.token.split(".");
    const tampered = encodeBase64Url(Buffer.from(JSON.stringify({ ...issued.claims, rev: 8 }), "utf8"));
    expectCode(() => harness.verifier.verifyAndConsume(`${h}.${tampered}.${s}`, harness.binding), "grant/bad-signature");
  });

  it("签名段被截断/补零 → bad-signature（不抛未捕获异常）", () => {
    const harness = createHarness();
    const issued = harness.issue();
    const [h, p, s] = issued.token.split(".");
    const short = Buffer.from(s!, "base64url").subarray(0, 32);
    expectCode(
      () => harness.verifier.verifyAndConsume(`${h}.${p}.${short.toString("base64url")}`, harness.binding),
      "grant/bad-signature",
    );
    const zeros = Buffer.alloc(64, 0);
    expectCode(
      () => harness.verifier.verifyAndConsume(`${h}.${p}.${zeros.toString("base64url")}`, harness.binding),
      "grant/bad-signature",
    );
  });

  it("kid 命中轮转中的旧公钥（仍然安装）→ 通过", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { privateKey: keyNext.privateKey, kid: keyNext.kid });
    expect(() => harness.verifier.verifyAndConsume(token, harness.binding)).not.toThrow();
  });

  it("kid 不在集合里 → unknown-kid", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { kid: "kid-unknown" });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/unknown-kid");
  });

  it("kid 缺失 → key-id-missing", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { header: { alg: "ES256", typ: "JWT" } });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/key-id-missing");
  });

  it("alg 被改成 none / HS256 / ES384 → unsupported-alg（固定算法，不回退）", () => {
    const harness = createHarness();
    for (const alg of ["none", "HS256", "ES384", "RS256", "", "es256"]) {
      const token = mintToken(baseClaims(), { header: { alg, typ: "JWT", kid: harness.signer.kid } });
      expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/unsupported-alg");
    }
  });

  it("alg 缺失（undefined）→ unsupported-alg", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { header: { typ: "JWT", kid: harness.signer.kid } });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/unsupported-alg");
  });

  it("typ 非 JWT → malformed", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), { header: { alg: "ES256", typ: "at+jwt", kid: harness.signer.kid } });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/malformed");
  });

  it("header 里的 jku/x5u 之类字段不参与选钥（kid 说了算）", () => {
    const harness = createHarness();
    const token = mintToken(baseClaims(), {
      privateKey: keyRogue.privateKey,
      header: { alg: "ES256", typ: "JWT", kid: harness.signer.kid, jku: "https://evil.example/jwks" },
    });
    expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/bad-signature");
  });
});

describe("密钥集合配置（构造即失败，运行期不补救）", () => {
  const base = { audience: AUDIENCE, tenantId: TENANT, bootId: BOOT, startedAt: NOW, issuer: ISSUER };

  it("空公钥集合 → keyset-missing（拒绝一切命令）", () => {
    expectCode(() => createGrantVerifier({ ...base, keys: [] }), "grant/keyset-missing");
  });

  it("非 P-256 曲线声明 → key-not-es256", () => {
    const key = generateTestKeyPair();
    expect(key.jwk.crv).toBe("P-256");
    expectCode(
      () => createGrantVerifier({ ...base, keys: [{ ...key.jwk, crv: "P-384" } as never] }),
      "grant/key-not-es256",
    );
  });

  it("JWKS 里带私钥材料 d → 拒绝", () => {
    expectCode(
      () => createGrantVerifier({ ...base, keys: [{ ...keyNext.jwk, d: "AAAA" } as never] }),
      "grant/key-not-es256",
    );
  });

  it("同一 kid 对应不同材料 → conflicting-key", () => {
    const a = generateTestKeyPair("kid-dup");
    const b = generateTestKeyPair("kid-dup");
    expectCode(() => createGrantVerifier({ ...base, keys: [a.jwk, b.jwk] }), "grant/conflicting-key");
  });

  it("x/y 长度不对 → key-not-es256", () => {
    expectCode(
      () => createGrantVerifier({ ...base, keys: [{ ...keyNext.jwk, x: "AAAA" }] }),
      "grant/key-not-es256",
    );
  });

  it("kid 非法字符 → key-id-missing", () => {
    expectCode(
      () => createGrantVerifier({ ...base, keys: [{ ...keyNext.jwk, kid: "kid with space" }] }),
      "grant/key-id-missing",
    );
  });

  it("alg 声明非 ES256 → key-not-es256", () => {
    expectCode(
      () => createGrantVerifier({ ...base, keys: [{ ...keyNext.jwk, alg: "HS256" }] }),
      "grant/key-not-es256",
    );
  });

  it("配置缺 audience/bootId/startedAt → signer-unavailable", () => {
    expectCode(() => createGrantVerifier({ ...base, audience: "", keys: [keyNext.jwk] }), "grant/signer-unavailable");
    expectCode(() => createGrantVerifier({ ...base, bootId: "", keys: [keyNext.jwk] }), "grant/signer-unavailable");
    expectCode(
      () => createGrantVerifier({ ...base, startedAt: -1, keys: [keyNext.jwk] }),
      "grant/signer-unavailable",
    );
  });

  it("keyset() 暴露的是归一化后的公开材料（无 d、无额外字段）", () => {
    const harness = createHarness();
    const snapshot = harness.verifier.keyset();
    expect(snapshot.jwks).toHaveLength(2);
    expect(snapshot.jwks[0]).toEqual({ kty: "EC", crv: "P-256", x: keyCurrent.jwk.x, y: keyCurrent.jwk.y, kid: keyCurrent.kid, alg: "ES256", use: "sig" });
    expect(JSON.stringify(snapshot.jwks)).not.toContain('"d"');
  });

  it("验签集合接受多把轮转公钥，且导入的 JWK 与导出的 PEM 是同一把钥匙", () => {
    const key = generateTestKeyPair("kid-pem");
    const verifier = createGrantVerifier({
      audience: AUDIENCE,
      tenantId: TENANT,
      bootId: BOOT,
      startedAt: NOW,
      issuer: ISSUER,
      keys: [key.jwk, keyNext.jwk],
      clock: createManualClock(NOW).now,
    });
    expect(verifier.keyset().keys.size).toBe(2);
    expect(verifier.keyset().keys.has("kid-pem")).toBe(true);
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY");

    const token = mintToken(baseClaims(), { privateKey: key.privateKey, kid: "kid-pem" });
    expect(() => verifier.verifyAndConsume(token, binding())).not.toThrow();
  });
});

describe("token 结构（畸形输入）", () => {
  const malformed: readonly [string, string][] = [
    ["空串", ""],
    ["单段", "abc"],
    ["两段", "a.b"],
    ["四段", "a.b.c.d"],
    ["header 非 JSON", `${encodeBase64Url(Buffer.from("not json"))}.${encodeBase64Url(Buffer.from("{}"))}.${encodeBase64Url(Buffer.alloc(64))}`],
    ["header 是数组", `${encodeBase64Url(Buffer.from("[1]"))}.${encodeBase64Url(Buffer.from("{}"))}.${encodeBase64Url(Buffer.alloc(64))}`],
    ["含标准 base64 的 + / =", "eyJhbGciOiJFUzI1NiJ9+.e30=.AAAA"],
    ["base64url 非规范（长度 mod 4 = 1）", "eyJhbGciOiJFUzI1NiJ9.e.AAAA"],
    ["空格分段", "a b.c.d"],
  ];

  for (const [label, token] of malformed) {
    it(`${label} → grant/malformed`, () => {
      const harness = createHarness();
      expectCode(() => harness.verifier.verifyAndConsume(token, harness.binding), "grant/malformed");
    });
  }

  it("非字符串 token → malformed", () => {
    const harness = createHarness();
    for (const value of [null, undefined, 42, {}, [], Buffer.from("x")]) {
      expectCode(() => harness.verifier.verifyAndConsume(value as never, harness.binding), "grant/malformed");
    }
  });

  it("超长 token → malformed（避免把校验器当解析放大器）", () => {
    const harness = createHarness();
    expectCode(() => harness.verifier.verifyAndConsume(`a.${"b".repeat(9000)}.c`, harness.binding), "grant/malformed");
  });
});

describe("bodyHash 与绑定摘要协同", () => {
  it("sha256Hex 对 UTF-8 与字节输入一致", () => {
    const text = "中文正文 with emoji 🚀";
    expect(sha256Hex(text)).toBe(sha256Hex(Buffer.from(text, "utf8")));
    expect(sha256Hex(text)).toHaveLength(64);
    expect(sha256Hex(text)).not.toBe(BODY_HASH);
    expect(sha256Hex(BODY)).toBe(BODY_HASH);
  });
});
