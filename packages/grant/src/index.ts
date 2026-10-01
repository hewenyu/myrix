/**
 * @myrix/grant —— Myrix 授权凭证（ES256 / JWS）。
 *
 * 控制面负责签发（`createGrantSigner`），cell 驱动负责校验并一次性消费
 * （`createGrantVerifier`）。两边共用同一张 claim 表，避免字段名漂移。
 *
 * 只用 Node 标准库：`node:crypto` 提供 P-256 密钥、SHA-256 与 ECDSA 签名。
 * 不依赖 dsh-shim、不依赖 DSH 内部类型、不引入第三方 JWT 库。
 *
 * 失败语义：一切校验失败都抛 `GrantError`，调用方必须拒绝命令（fail-closed）。
 * `GrantError.toWire()` 给出可读且不含敏感信息的原因，可直接进 HTTP 响应。
 */

export {
  GRANT_ERROR_CODES,
  GrantError,
  stageOf,
  type GrantErrorCode,
  type GrantErrorDetails,
  type GrantErrorDetailValue,
  type GrantErrorWire,
  type GrantFailureStage,
} from "./errors";

export { parseBearerToken } from "./bearer";

export { createManualClock, systemClockSeconds, type GrantClock, type ManualClock } from "./clock";

export {
  CLAIM_SPECS,
  GRANT_ALG,
  GRANT_OPERATIONS,
  GRANT_TTL_SECONDS,
  GRANT_TYP,
  KNOWN_CLAIMS,
  isGrantOperation,
  isIdentifier,
  isNonNegativeInteger,
  isPlainString,
  readClaim,
  type ClaimSpec,
  type ClaimTypeName,
  type GrantAction,
  type GrantBindingCheck,
  type GrantOperation,
} from "./claims";

export {
  MAX_TOKEN_LENGTH,
  buildSigningInput,
  decodeBase64Url,
  decodeJwsCompact,
  decodePayloadObject,
  encodeBase64Url,
  type DecodedJws,
  type JwsHeader,
} from "./jws";

export {
  SHA256_HEX_PATTERN,
  isSha256Hex,
  sha256Hex,
} from "./sha256";

export {
  assertP256PrivateKey,
  assertP256PublicKey,
  assertValidKid,
  normalizeKeyset,
  publicKeyToJwk,
  selectVerificationKey,
  toPrivateKeyObject,
  toPublicKeyObject,
  type GrantKeySource,
  type GrantPublicJwk,
  type NormalizedKeyset,
} from "./keys";

export { createJtiStore, type JtiStore, type JtiStoreOptions, type JtiStoreStats } from "./jti";

export {
  bodyHash,
  createGrantSigner,
  type GrantSigner,
  type GrantSignerOptions,
  type IssueGrantInput,
  type IssuedGrant,
} from "./signer";

export {
  DEFAULT_CLOCK_SKEW_SECONDS,
  createGrantVerifier,
  toAuditClaims,
  type GrantVerifier,
  type GrantVerifierOptions,
} from "./verifier";

export { toGrantClaims, type GrantAuditClaims, type GrantClaims, type GrantClaimsJson, type GrantVerifyBinding } from "./types";

export { generateTestKeyPair, type GeneratedGrantKeyPair } from "./testing";
