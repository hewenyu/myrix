import { describe, expect, it } from "vitest";
import {
  GRANT_ALG,
  GRANT_TTL_SECONDS,
  GRANT_TYP,
  GrantError,
  bodyHash,
  createGrantSigner,
  createManualClock,
  decodeJwsCompact,
  decodePayloadObject,
  generateTestKeyPair,
  isGrantOperation,
  sha256Hex,
} from "../src/index";
import { AUDIENCE, BOOT, BODY, NOW, expectCode } from "./helpers";

const key = generateTestKeyPair("kid-2026-09");

function signerAt(clockSeconds = NOW) {
  const clock = createManualClock(clockSeconds);
  return {
    clock,
    signer: createGrantSigner({
      privateKey: key.privateKey,
      kid: key.kid,
      issuer: "myrix-control-plane",
      clock: clock.now,
    }),
  };
}

const input = {
  aud: AUDIENCE,
  boot: BOOT,
  tid: "t_acme",
  sid: "sid-1",
  sub: "u_1001",
  wid: "w_1",
  preset: "novel-chapter",
  rev: 3,
  op: "send" as const,
  cmd: "cmd-1",
  rawBody: BODY,
};

describe("签发（ES256 / compact JWS）", () => {
  it("签出三段式 compact JWS，header 固定 alg/kid、payload 是全部 15 个 claim", () => {
    const { signer } = signerAt();
    const issued = signer.issue(input);

    const segments = issued.token.split(".");
    expect(segments).toHaveLength(3);

    const decoded = decodeJwsCompact(issued.token);
    expect(decoded.header).toEqual({ alg: GRANT_ALG, typ: GRANT_TYP, kid: key.kid });
    expect(decoded.signature).toHaveLength(64); // P-1363 原始签名，不是 DER

    const payload = decodePayloadObject(decoded.payload);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "iss", "aud", "boot", "tid", "sid", "sub", "wid", "preset", "rev",
        "op", "cmd", "bh", "jti", "iat", "exp",
      ].sort(),
    );
    expect(payload).toMatchObject({
      iss: "myrix-control-plane",
      aud: AUDIENCE,
      boot: BOOT,
      tid: "t_acme",
      sid: "sid-1",
      sub: "u_1001",
      wid: "w_1",
      preset: "novel-chapter",
      rev: 3,
      op: "send",
      cmd: "cmd-1",
      bh: sha256Hex(BODY),
      iat: NOW,
      exp: NOW + GRANT_TTL_SECONDS,
    });
  });

  it("TTL 固定 60s：exp - iat 恰好等于 60", () => {
    const { signer } = signerAt();
    const issued = signer.issue(input);
    expect(issued.claims.exp - issued.claims.iat).toBe(GRANT_TTL_SECONDS);
  });

  it("每次签发都换新 jti（同 cmd 重试 = 新凭证）", () => {
    const { signer } = signerAt();
    const first = signer.issue(input);
    const retry = signer.issue(input);
    expect(retry.claims.jti).not.toBe(first.claims.jti);
    expect(retry.claims.cmd).toBe(first.claims.cmd);
    expect(retry.token).not.toBe(first.token);
  });

  it("bodyHash 与 sha256Hex 一致，且对同一正文稳定", () => {
    expect(bodyHash(BODY)).toBe(sha256Hex(BODY));
    expect(bodyHash(BODY)).toHaveLength(64);
    expect(bodyHash(BODY)).not.toBe(bodyHash("另一段正文"));
  });

  it("拒绝 TTL 超过上限与非法 TTL 配置", () => {
    const clock = createManualClock(NOW);
    expectCode(
      () =>
        createGrantSigner({
          privateKey: key.privateKey,
          kid: key.kid,
          issuer: "myrix-control-plane",
          clock: clock.now,
          ttlSeconds: 61,
        }),
      "grant/signer-unavailable",
    );
  });

  it("缺 issuer / 空 kid / 私钥材质不对时拒绝构造（fail-closed）", () => {
    const clock = createManualClock(NOW);
    expectCode(
      () => createGrantSigner({ privateKey: key.privateKey, kid: "", issuer: "x", clock: clock.now }),
      "grant/key-id-missing",
    );
    expectCode(
      () => createGrantSigner({ privateKey: key.privateKey, kid: key.kid, issuer: "", clock: clock.now }),
      "grant/signer-unavailable",
    );
    expectCode(
      () => createGrantSigner({ privateKey: key.publicKey, kid: key.kid, issuer: "x", clock: clock.now }),
      "grant/key-not-es256",
    );
  });

  it("签发前自检：非法 claim（如 rev 负数、cmd 带空白）不会签出去", () => {
    const { signer } = signerAt();
    expectCode(() => signer.issue({ ...input, rev: -1 }), "grant/invalid-claims");
    expectCode(() => signer.issue({ ...input, cmd: "cmd 1" }), "grant/invalid-claims");
    expectCode(() => signer.issue({ ...input, sid: "sid.1" }), "grant/invalid-claims");
    expectCode(() => signer.issue({ ...input, sid: "sid\u0000bad" }), "grant/invalid-claims");
  });

  it("签出的 ISS 取自定义 issuer，而不是硬编码", () => {
    const clock = createManualClock(NOW);
    const signer = createGrantSigner({
      privateKey: key.privateKey,
      kid: key.kid,
      issuer: "myrix-control-plane-eu",
      clock: clock.now,
    });
    expect(signer.issue(input).claims.iss).toBe("myrix-control-plane-eu");
  });

  it("GrantError 提供可读且稳定分层的错误形状", () => {
    const error = new GrantError("grant/boot-mismatch", "boot 不是本进程的 bootId", { claim: "boot" });
    expect(error.toWire()).toEqual({
      error: "grant_rejected",
      code: "grant/boot-mismatch",
      reason: "boot 不是本进程的 bootId",
      stage: "binding",
      details: { claim: "boot" },
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toWire());
  });

  it("操作集合固定为 create|resume|send|cancel|subscribe", () => {
    for (const op of ["create", "resume", "send", "cancel", "subscribe"]) {
      expect(isGrantOperation(op)).toBe(true);
    }
    for (const op of ["delete", "CREATE", "", 7, null, undefined]) {
      expect(isGrantOperation(op)).toBe(false);
    }
  });
});
