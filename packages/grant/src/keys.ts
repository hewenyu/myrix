/**
 * 公钥集合（JWKS 形态）与密钥材料。
 *
 * 安全约束：
 * - 只接受 EC / P-256（ES256）；其它曲线、RSA、oct 一律拒绝，不做算法回退。
 * - 私钥材料（`d`）不允许出现在验签集合里。
 * - 同一个 kid 映射到不同密钥材料 = 部署事故，直接失败，避免“挑一把能过的钥匙”。
 * - kid 之外的任何 header 字段都不参与选钥（没有 jku/x5u/kid 前缀协商）。
 */
import { KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import { GrantError } from "./errors";
import { decodeBase64Url } from "./jws";

/** 只收 P-256 公钥的 JWK 子集。 */
export interface GrantPublicJwk {
  kty: "EC";
  crv: "P-256";
  /** base64url 的 32 字节 X 坐标 */
  x: string;
  /** base64url 的 32 字节 Y 坐标 */
  y: string;
  /** 轮转 id；验签时按它选公钥 */
  kid: string;
  /** 若提供必须是 ES256 */
  alg?: string;
  /** 若提供必须是 sig */
  use?: string;
}

export type GrantKeySource = KeyObject | string | Uint8Array;

/** kid 允许的字符集：JWKS 里常见的 key id 形态。 */
const KID_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;

export function assertValidKid(kid: unknown, field = "kid"): string {
  if (typeof kid !== "string" || kid.length === 0) {
    throw new GrantError("grant/key-id-missing", `${field} 缺失或为空`);
  }
  if (!KID_PATTERN.test(kid)) {
    throw new GrantError("grant/key-id-missing", `${field} 含不允许的字符`, { kidLength: kid.length });
  }
  return kid;
}

/** 断言 KeyObject 是 ES256 可用的 P-256 公钥。 */
export function assertP256PublicKey(key: KeyObject, kid: string): void {
  if (key.type !== "public") {
    throw new GrantError("grant/key-not-es256", "验签密钥必须是公钥", { kid, keyType: key.type });
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new GrantError("grant/key-not-es256", "验签密钥必须是 EC P-256（ES256）", {
      kid,
      keyType: key.asymmetricKeyType ?? "unknown",
      curve: key.asymmetricKeyDetails?.namedCurve ?? "unknown",
    });
  }
}

/** 断言 KeyObject 是 ES256 可用的 P-256 私钥。 */
export function assertP256PrivateKey(key: KeyObject, kid = "signing-key"): void {
  if (key.type !== "private") {
    throw new GrantError("grant/key-not-es256", "签名密钥必须是私钥", { kid, keyType: key.type });
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new GrantError("grant/key-not-es256", "签名密钥必须是 EC P-256（ES256）", {
      kid,
      keyType: key.asymmetricKeyType ?? "unknown",
      curve: key.asymmetricKeyDetails?.namedCurve ?? "unknown",
    });
  }
}

/** KeyObject / PEM / DER → 公钥对象。 */
export function toPublicKeyObject(source: GrantKeySource, kid: string): KeyObject {
  let key: KeyObject;
  try {
    key = source instanceof KeyObject ? source : createPublicKey(source as never);
  } catch (error) {
    throw new GrantError("grant/key-not-es256", "无法解析验签公钥材料", {
      kid,
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
  assertP256PublicKey(key, kid);
  return key;
}

/** KeyObject / PEM / DER → 私钥对象。 */
export function toPrivateKeyObject(source: GrantKeySource, kid = "signing-key"): KeyObject {
  let key: KeyObject;
  try {
    key = source instanceof KeyObject ? source : createPrivateKey(source as never);
  } catch (error) {
    throw new GrantError("grant/key-not-es256", "无法解析签名私钥材料", {
      kid,
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
  assertP256PrivateKey(key, kid);
  return key;
}

/** 公钥对象 → 可进 JWKS 的 JWK（只含公开字段）。 */
export function publicKeyToJwk(key: KeyObject, kid: string): GrantPublicJwk {
  assertP256PublicKey(key, kid);
  const exported = key.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y) {
    throw new GrantError("grant/key-not-es256", "公钥无法导出为 P-256 JWK", { kid });
  }
  return { kty: "EC", crv: "P-256", x: exported.x, y: exported.y, kid, alg: "ES256", use: "sig" };
}

function assertPublicJwkShape(jwk: GrantPublicJwk): void {
  if (jwk.kty !== "EC") {
    throw new GrantError("grant/key-not-es256", "JWK.kty 必须是 EC", { kid: jwk.kid, kty: String(jwk.kty) });
  }
  if (jwk.crv !== "P-256") {
    throw new GrantError("grant/key-not-es256", "JWK.crv 必须是 P-256", { kid: jwk.kid, crv: String(jwk.crv) });
  }
  if (jwk.alg !== undefined && jwk.alg !== "ES256") {
    throw new GrantError("grant/key-not-es256", "JWK.alg 只能是 ES256", { kid: jwk.kid, alg: jwk.alg });
  }
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new GrantError("grant/key-not-es256", "JWK.use 只能是 sig", { kid: jwk.kid, use: jwk.use });
  }
  for (const [name, value] of [
    ["x", jwk.x],
    ["y", jwk.y],
  ] as const) {
    if (typeof value !== "string") {
      throw new GrantError("grant/key-not-es256", `JWK.${name} 缺失`, { kid: jwk.kid });
    }
    if (decodeBase64Url(value).length !== 32) {
      throw new GrantError("grant/key-not-es256", `JWK.${name} 必须是 32 字节的 base64url`, { kid: jwk.kid });
    }
  }
}

export interface NormalizedKeyset {
  /** kid → 公钥对象 */
  keys: ReadonlyMap<string, KeyObject>;
  /** kid → 原始 JWK，便于诊断与 JWKS 转发 */
  jwks: readonly GrantPublicJwk[];
}

/**
 * 归一化验签公钥集合。
 * 空集合直接失败：没有公钥就不能验签，绝不放行。
 */
export function normalizeKeyset(jwks: readonly GrantPublicJwk[]): NormalizedKeyset {
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new GrantError("grant/keyset-missing", "验签公钥集合为空，拒绝一切凭证");
  }
  const keys = new Map<string, KeyObject>();
  const seen = new Map<string, string>();
  const normalized: GrantPublicJwk[] = [];

  for (const raw of jwks) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new GrantError("grant/key-not-es256", "JWKS 条目不是对象");
    }
    if ("d" in (raw as Record<string, unknown>)) {
      throw new GrantError("grant/key-not-es256", "JWKS 里不允许出现私钥材料 d", { kid: String(raw.kid ?? "") });
    }
    const kid = assertValidKid(raw.kid, "JWKS.kid");
    assertPublicJwkShape({ ...raw, kid });
    const fingerprint = `${raw.x}.${raw.y}`;
    const existing = seen.get(kid);
    if (existing !== undefined && existing !== fingerprint) {
      throw new GrantError("grant/conflicting-key", "同一 kid 对应了不同的公钥材料", { kid });
    }
    if (existing === undefined) {
      seen.set(kid, fingerprint);
      let keyObject: KeyObject;
      try {
        keyObject = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.x, y: raw.y }, format: "jwk" });
      } catch {
        throw new GrantError("grant/key-not-es256", "JWK 无法构造 P-256 公钥", { kid });
      }
      assertP256PublicKey(keyObject, kid);
      keys.set(kid, keyObject);
      normalized.push({ kty: "EC", crv: "P-256", x: raw.x, y: raw.y, kid, alg: "ES256", use: "sig" });
    }
  }

  return { keys, jwks: normalized };
}

/** 按 kid 取验签公钥；找不到就是拒绝，不退回“第一把钥匙”。 */
export function selectVerificationKey(keyset: NormalizedKeyset, kid: string): KeyObject {
  if (keyset.keys.size === 0) {
    throw new GrantError("grant/keyset-missing", "验签公钥集合为空，拒绝一切凭证");
  }
  const key = keyset.keys.get(kid);
  if (!key) {
    throw new GrantError("grant/unknown-kid", "header.kid 不在已安装的公钥集合中", {
      kid,
      installedKids: [...keyset.keys.keys()].join(","),
    });
  }
  return key;
}
