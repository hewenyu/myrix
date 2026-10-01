/**
 * 授权凭证的 claim 载体类型，以及签发方/校验方的公开输入形状。
 *
 * 控制面用同一份类型签发，driver 用同一份类型读取，避免两边各写一套字段名。
 */
import type { GrantOperation } from "./claims";

/** 凭证里的授权声明；不含任何密钥或正文。 */
export interface GrantClaims {
  /** 签发方，固定 myrix-control-plane。 */
  iss: string;
  /** 受众 = cellId。 */
  aud: string;
  /** cell 当前 bootId。 */
  boot: string;
  tid: string;
  sid: string;
  sub: string;
  wid: string;
  preset: string;
  /** 策略/撤权版本。 */
  rev: number;
  op: GrantOperation;
  /** commandId；重试时保持不变。 */
  cmd: string;
  /** 请求体 SHA-256（小写十六进制）。 */
  bh: string;
  /** 一次性凭证 id；每次签发（含重试）都必须新生成。 */
  jti: string;
  /** 签发时间（Unix 秒）。 */
  iat: number;
  /** 过期时间（Unix 秒），必须晚于 iat 且不超过 60s。 */
  exp: number;
}

export type GrantClaimsJson = GrantClaims & { [extra: string]: unknown };
/**
 * verifyAndConsume 的业务绑定：调用方把“本次请求实际是什么”传进来，
 * 校验器负责与凭证里的声明逐项比对。`aud`/`tid`/`boot` 是进程级配置，不在这里。
 */
export interface GrantVerifyBinding {
  /** 本次请求实际承载的操作。 */
  op: GrantOperation;
  /** 本次请求的实际 commandId。 */
  cmd: string;
  /** 本次请求正文的 SHA-256（小写十六进制）。 */
  bh: string;
}

/** 供审计/日志使用的 claim 快照：只含非敏感字段。 */
export interface GrantAuditClaims {
  iss: string;
  aud: string;
  boot: string;
  tid: string;
  sid: string;
  sub: string;
  wid: string;
  preset: string;
  rev: number;
  op: GrantOperation;
  cmd: string;
  bh: string;
  jti: string;
  iat: number;
  exp: number;
}

export function toGrantClaims(claims: GrantClaimsJson): GrantClaims {
  return {
    iss: claims.iss,
    aud: claims.aud,
    boot: claims.boot,
    tid: claims.tid,
    sid: claims.sid,
    sub: claims.sub,
    wid: claims.wid,
    preset: claims.preset,
    rev: claims.rev,
    op: claims.op,
    cmd: claims.cmd,
    bh: claims.bh,
    jti: claims.jti,
    iat: claims.iat,
    exp: claims.exp,
  };
}
