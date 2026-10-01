/**
 * 测试/本地开发辅助：生成 P-256 密钥对。
 *
 * 放在 `src` 而不是 `tests`，是因为控制面的本地演示与 driver 的集成测试都要用；
 * 生产路径永远从 KMS / Secret 注入，不调用这里的生成函数。
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { publicKeyToJwk, type GrantPublicJwk } from "./keys";

export interface GeneratedGrantKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: GrantPublicJwk;
  /** PKCS#8 PEM，方便塞进 Secret 的字符串形态。 */
  privateKeyPem: string;
  /** SPKI PEM。 */
  publicKeyPem: string;
}

export function generateTestKeyPair(kid = "test-kid-1"): GeneratedGrantKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    kid,
    privateKey,
    publicKey,
    jwk: publicKeyToJwk(publicKey, kid),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}
