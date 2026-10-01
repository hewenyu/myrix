/**
 * ES256 (JWS) 签发。
 *
 * 只签固定 `alg=ES256`、固定 `typ=JWT`，`kid` 由调用方显式给出（轮转 id）。
 * 私钥由调用方注入：KMS 或受控 Secret 里取，包本身不读文件、不读环境变量。
 */
import { randomUUID, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  CLAIM_SPECS,
  GRANT_ALG,
  GRANT_TTL_SECONDS,
  GRANT_TYP,
  isGrantOperation,
  readClaim,
  type GrantOperation,
} from "./claims";
import type { GrantClock } from "./clock";
import { systemClockSeconds } from "./clock";
import { GrantError } from "./errors";
import { buildSigningInput } from "./jws";
import { assertValidKid, toPrivateKeyObject, type GrantKeySource } from "./keys";
import { sha256Hex } from "./sha256";
import type { GrantClaims, GrantClaimsJson } from "./types";

/** 新签发的凭证：token 之外的元信息只用于日志与审计。 */
export interface IssuedGrant {
  /** compact JWS，直接作为 `Authorization: Bearer` 的值。 */
  token: string;
  /** 与 token 内一致的 header。 */
  header: { alg: typeof GRANT_ALG; typ: typeof GRANT_TYP; kid: string };
  claims: GrantClaims;
  /** header.payload 的 base64url 拼接，便于审计侧核对签名输入。 */
  signingInput: string;
}

export interface GrantSignerOptions {
  /** ES256 私钥：KeyObject / PEM / DER。 */
  privateKey: GrantKeySource;
  /** 轮转 id，写进 header.kid。 */
  kid: string;
  /** 签发方 claim，固定 myrix-control-plane。 */
  issuer: string;
  /** 注入时钟（秒）。 */
  clock?: GrantClock;
  /** 默认 TTL；上限 60s 由校验方强制，这里也做同样的约束。 */
  ttlSeconds?: number;
}

/** 签发输入：除 iss/iat/exp/jti 之外的授权声明。 */
export interface IssueGrantInput {
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
  /** 原始请求体；调用方直接传字节或字符串，摘要由签发方计算。 */
  rawBody: Uint8Array | string;
}

/** 计算 `bh` claim：小写十六进制 SHA-256。等价于 `sha256Hex(rawBody)`。 */
export function bodyHash(rawBody: Uint8Array | string): string {
  return sha256Hex(rawBody);
}

export interface GrantSigner {
  /** 签发一枚 60s 有效的一次性凭证。 */
  issue(input: IssueGrantInput): IssuedGrant;
  /** 只算摘要不签发；调用方拿它与凭证里的 bh 对账用不到（校验在验签侧做）。 */
  bodyHash(rawBody: Uint8Array | string): string;
  readonly kid: string;
  readonly issuer: string;
}

export function createGrantSigner(options: GrantSignerOptions): GrantSigner {
  const privateKey: KeyObject = toPrivateKeyObject(options.privateKey, options.kid);
  const kid = assertValidKid(options.kid, "kid");
  if (typeof options.issuer !== "string" || options.issuer.length === 0) {
    throw new GrantError("grant/signer-unavailable", "issuer 未配置，拒绝签发");
  }
  const clock = options.clock ?? systemClockSeconds;
  const ttl = options.ttlSeconds ?? GRANT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > GRANT_TTL_SECONDS) {
    throw new GrantError("grant/signer-unavailable", `ttlSeconds 必须在 1..${GRANT_TTL_SECONDS} 之间`, { ttl });
  }

  const header = { alg: GRANT_ALG, typ: GRANT_TYP, kid } as const;

  return {
    kid,
    issuer: options.issuer,

    bodyHash,

    issue(input: IssueGrantInput): IssuedGrant {
      const iat = clock();
      if (!Number.isSafeInteger(iat) || iat < 0) {
        throw new GrantError("grant/signer-unavailable", "注入时钟返回了非法的 Unix 秒");
      }
      const payload: GrantClaimsJson = {
        iss: options.issuer,
        aud: input.aud,
        boot: input.boot,
        tid: input.tid,
        sid: input.sid,
        sub: input.sub,
        wid: input.wid,
        preset: input.preset,
        rev: input.rev,
        op: input.op,
        cmd: input.cmd,
        bh: bodyHash(input.rawBody),
        jti: randomUUID(),
        iat,
        exp: iat + ttl,
      };

      // 签发前用与校验侧同一张 claim 表自检：签出去的凭证必须自己是合法的。
      for (const spec of CLAIM_SPECS) {
        if (spec.name === "op") continue;
        readClaim(payload, spec.name);
      }
      if (!isGrantOperation(payload.op)) {
        throw new GrantError("grant/invalid-claims", "op 不在允许的操作集合内", { claim: "op" });
      }
      if (payload.exp - payload.iat !== ttl) {
        throw new GrantError("grant/invalid-claims", "exp 必须等于 iat + ttl", {
          iat: payload.iat,
          exp: payload.exp,
          ttl,
        });
      }

      const signingInput = buildSigningInput(header, payload);
      let signature: Buffer;
      try {
        signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        });
      } catch (error) {
        throw new GrantError("grant/signer-unavailable", "ES256 签名失败", {
          cause: error instanceof Error ? error.name : "unknown",
        });
      }

      return {
        token: `${signingInput}.${signature.toString("base64url")}`,
        header: { alg: GRANT_ALG, typ: GRANT_TYP, kid },
        claims: payload,
        signingInput,
      };
    },
  };
}
