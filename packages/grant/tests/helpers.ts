/**
 * 测试辅助：真密钥、注入时钟、以及“签名合法但 claim 被改过”的铸币器。
 *
 * `mintToken` 刻意绕开 signer 的入参校验，直接对任意 claim 集合签名，
 * 这样每个 claim 的负例都只由“该 claim 非法”导致，不会被别的原因掩盖。
 */
import { randomUUID, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  GRANT_ALG,
  GRANT_TYP,
  buildSigningInput,
  createGrantSigner,
  createGrantVerifier,
  createManualClock,
  generateTestKeyPair,
  sha256Hex,
  type GrantClaimsJson,
  type GrantOperation,
  type GrantSigner,
  type GrantVerifier,
  type GrantVerifierOptions,
  type GrantVerifyBinding,
  type ManualClock,
} from "../src/index";

/** 固定基准时刻（Unix 秒）。 */
export const NOW = 1_790_000_000;
export const ISSUER = "myrix-control-plane";
export const AUDIENCE = "cell-u_1";
export const TENANT = "t_acme";
export const BOOT = "boot-0001";
export const OTHER_BOOT = "boot-0002";
export const BODY = JSON.stringify({ text: "写一个开头", sessionId: "sid-1" });
export const OTHER_BODY = JSON.stringify({ text: "写另一个开头", sessionId: "sid-1" });
export const BODY_HASH = sha256Hex(BODY);
export const OTHER_BODY_HASH = sha256Hex(OTHER_BODY);

export const keyCurrent = generateTestKeyPair("kid-2026-09");
export const keyNext = generateTestKeyPair("kid-2026-10");
export const keyRogue = generateTestKeyPair("kid-rogue");

export function baseClaims(overrides: Partial<GrantClaimsJson> = {}): GrantClaimsJson {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    boot: BOOT,
    tid: TENANT,
    sid: "sid-1",
    sub: "u_1001",
    wid: "w_1",
    preset: "novel-chapter",
    rev: 7,
    op: "send",
    cmd: "cmd-1",
    bh: BODY_HASH,
    jti: `jti-${randomUUID()}`,
    iat: NOW,
    exp: NOW + 60,
    ...overrides,
  };
}

/**
 * 用任意“原始 payload 文本”铸一枚签名合法的 token。
 * 用于测试 payload 根本不是 JSON 对象的路径（正常 mintToken 只能给对象）。
 */
export function signRawPayload(rawPayload: string, kid: string = keyCurrent.kid): string {
  const header = { alg: GRANT_ALG, typ: GRANT_TYP, kid };
  const signingInput = buildSigningInput(header, JSON.parse(rawPayload));
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: keyCurrent.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** 以某个 claim 的任意取值构造 payload；value 为 undefined 时该 claim 从 JSON 里消失。 */
export function claimWith(name: string, value: unknown): GrantClaimsJson {
  const claims = baseClaims() as unknown as Record<string, unknown>;
  claims[name] = value;
  return claims as unknown as GrantClaimsJson;
}

export interface MintOptions {
  privateKey?: KeyObject;
  kid?: string;
  header?: Record<string, unknown>;
}

/** 用任意 header/payload 铸一枚签名合法的 token。 */
export function mintToken(payload: GrantClaimsJson, options: MintOptions = {}): string {
  const header = options.header ?? { alg: GRANT_ALG, typ: GRANT_TYP, kid: options.kid ?? keyCurrent.kid };
  const signingInput = buildSigningInput(header, payload);
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: options.privateKey ?? keyCurrent.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function binding(overrides: Partial<GrantVerifyBinding> = {}): GrantVerifyBinding {
  return { op: "send", cmd: "cmd-1", bh: BODY_HASH, ...overrides };
}

export interface Harness {
  clock: ManualClock;
  signer: GrantSigner;
  verifier: GrantVerifier;
  /** 默认绑定：op=send、cmd=cmd-1、bh=BODY 的摘要。 */
  binding: GrantVerifyBinding;
  /** 用签发器签一枚默认凭证。 */
  issue(overrides?: Partial<Parameters<GrantSigner["issue"]>[0]>): ReturnType<GrantSigner["issue"]>;
}

export function createHarness(
  verifierOverrides: Partial<GrantVerifierOptions> = {},
  clockStart = NOW,
): Harness {
  const clock = createManualClock(clockStart);
  const signer = createGrantSigner({
    privateKey: keyCurrent.privateKey,
    kid: keyCurrent.kid,
    issuer: ISSUER,
    clock: clock.now,
  });
  const verifier = createGrantVerifier({
    audience: AUDIENCE,
    tenantId: TENANT,
    bootId: BOOT,
    startedAt: NOW,
    issuer: ISSUER,
    keys: [keyCurrent.jwk, keyNext.jwk],
    clock: clock.now,
    ...verifierOverrides,
  });
  return {
    clock,
    signer,
    verifier,
    binding: binding(),
    issue(overrides = {}) {
      return signer.issue({
        aud: AUDIENCE,
        boot: BOOT,
        tid: TENANT,
        sid: "sid-1",
        sub: "u_1001",
        wid: "w_1",
        preset: "novel-chapter",
        rev: 7,
        op: "send",
        cmd: "cmd-1",
        rawBody: BODY,
        ...overrides,
      });
    },
  };
}

/** 断言抛出的 GrantError 的稳定错误码；返回错误对象便于进一步断言。 */
export function expectCode(fn: () => unknown, code: string): { code: string; message: string } {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`预期抛出 ${code}，但调用成功了`);
  }
  const actual = (thrown as { code?: string }).code;
  if (actual !== code) {
    throw new Error(`预期错误码 ${code}，实际 ${String(actual)}（${(thrown as Error).message}）`);
  }
  return { code: actual, message: (thrown as Error).message };
}

export function opOf(op: GrantOperation): GrantOperation {
  return op;
}
