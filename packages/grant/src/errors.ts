/**
 * 授权凭证的错误模型。
 *
 * 约定：
 * - 校验失败一律 fail-closed：调用方拿到失败就拒绝命令，不做“降级放行”。
 * - `code` 稳定，供日志、审计、测试与前端分支使用；`reason` 是给人看的可读原因。
 * - 不要把密钥材料、完整 token 或正文放进 `details`。
 */

/** 稳定错误码。新增请追加，不要改名。 */
export const GRANT_ERROR_CODES = [
  /** token 不是三段式 compact JWS、JSON 坏了、base64url 非规范或超长 */
  "grant/malformed",
  /** header.alg 缺失或不是固定的 ES256 */
  "grant/unsupported-alg",
  /** header.kid 缺失或不是非空字符串 */
  "grant/key-id-missing",
  /** header.kid 不在已安装的公钥集合里 */
  "grant/unknown-kid",
  /** 签名验证失败（被篡改、密钥不匹配） */
  "grant/bad-signature",
  /** claim 的类型或取值违反约束 */
  "grant/invalid-claims",
  /** exp 已过（含允许的时钟偏差） */
  "grant/expired",
  /** iat 早于本进程启动门槛，属于重启前签发的凭证 */
  "grant/too-old",
  /** boot 与本进程 bootId 不一致 */
  "grant/boot-mismatch",
  /** aud 与本 cell 不一致 */
  "grant/audience-mismatch",
  /** tid 与本 cell 租户不一致 */
  "grant/tenant-mismatch",
  /** op 或 cmd 与本次调用期望不一致 */
  "grant/operation-mismatch",
  /** bh 与请求正文摘要不一致 */
  "grant/body-hash-mismatch",
  /** jti 已被消费（重放） */
  "grant/replayed",
  /** 公钥集合为空，或按 kid 找不到对应的验签公钥 */
  "grant/keyset-missing",
  /** 密钥材料不是 P-256/ES256 */
  "grant/key-not-es256",
  /** 签名钥与同 kid 的验签公钥不一致（部署配置错误） */
  "grant/conflicting-key",
  /** 签发方特有的错误：配置缺失、时钟不可用等 */
  "grant/signer-unavailable",
] as const;

export type GrantErrorCode = (typeof GRANT_ERROR_CODES)[number];

/** 校验阶段，便于定位是“格式 / 签名 / 声明 / 时效 / 绑定 / 重放”哪一层拒绝的。 */
export type GrantFailureStage =
  | "format"
  | "signature"
  | "claims"
  | "time"
  | "binding"
  | "replay"
  | "configuration";

export type GrantErrorDetailValue = string | number | boolean;

export interface GrantErrorDetails {
  readonly [key: string]: GrantErrorDetailValue;
}

const STAGE_BY_CODE: Record<GrantErrorCode, GrantFailureStage> = {
  "grant/malformed": "format",
  "grant/unsupported-alg": "format",
  "grant/key-id-missing": "format",
  "grant/unknown-kid": "signature",
  "grant/bad-signature": "signature",
  "grant/invalid-claims": "claims",
  "grant/expired": "time",
  "grant/too-old": "time",
  "grant/boot-mismatch": "binding",
  "grant/audience-mismatch": "binding",
  "grant/tenant-mismatch": "binding",
  "grant/operation-mismatch": "binding",
  "grant/body-hash-mismatch": "binding",
  "grant/replayed": "replay",
  "grant/keyset-missing": "configuration",
  "grant/key-not-es256": "configuration",
  "grant/conflicting-key": "configuration",
  "grant/signer-unavailable": "configuration",
};

export function stageOf(code: GrantErrorCode): GrantFailureStage {
  return STAGE_BY_CODE[code];
}

/** 线协议错误形状，与 BFF 的 `{ error, reason }` 约定保持一致。 */
export interface GrantErrorWire {
  readonly error: "grant_rejected";
  readonly code: GrantErrorCode;
  readonly reason: string;
  readonly stage: GrantFailureStage;
  readonly details: GrantErrorDetails;
}

export class GrantError extends Error {
  readonly code: GrantErrorCode;
  readonly reason: string;
  readonly stage: GrantFailureStage;
  readonly details: GrantErrorDetails;

  constructor(code: GrantErrorCode, reason: string, details: GrantErrorDetails = {}) {
    super(`${code}: ${reason}`);
    this.name = "GrantError";
    this.code = code;
    this.reason = reason;
    this.stage = stageOf(code);
    this.details = details;
  }

  /** 可直接进 HTTP 响应体；不含 token、密钥或正文。 */
  toWire(): GrantErrorWire {
    return {
      error: "grant_rejected",
      code: this.code,
      reason: this.reason,
      stage: this.stage,
      details: this.details,
    };
  }

  toJSON(): GrantErrorWire {
    return this.toWire();
  }
}
