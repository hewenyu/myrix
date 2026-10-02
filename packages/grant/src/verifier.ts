/**
 * ES256 (JWS) 严格校验 + 一次性消费。
 *
 * 校验顺序（任何一步失败都抛 GrantError，绝不返回“部分通过”）：
 *   1. 结构：三段式 compact JWS、base64url 规范、header/payload 是 JSON 对象
 *   2. 算法：header.alg 必须恰好是 ES256（固定算法，不做协商、不回退）
 *   3. 选钥：header.kid 必须命中已安装的 P-256 公钥
 *   4. 签名：node:crypto verify（P-1363 原始签名）
 *   5. claim：逐项类型与取值约束（见 claims.ts 的 CLAIM_SPECS）
 *   6. 时效：iat ≥ 进程启动门槛、iat 不在未来、exp 已过、iat..exp 跨度 ≤ 60s
 *   7. 绑定：iss / aud / tid / boot / op / cmd / bh 与本次调用预期一致
 *   8. 重放：以上全部通过后，才消费 jti（一次性）
 *
 * 第 8 步放在最后是刻意的：签名或任何绑定校验失败时消费 jti，等于让攻击者/错误客户端
 * 用一次坏请求把合法凭证烧掉（可用性攻击面）。
 */
import { verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  GRANT_ALG,
  GRANT_TTL_SECONDS,
  GRANT_TYP,
  GRANT_OPERATIONS,
  isGrantOperation,
  readClaim,
} from "./claims";
import type { GrantClock } from "./clock";
import { systemClockSeconds } from "./clock";
import { GrantError } from "./errors";
import { decodeJwsCompact, decodePayloadObject } from "./jws";
import { normalizeKeyset, selectVerificationKey, type GrantPublicJwk, type NormalizedKeyset } from "./keys";
import { createJtiStore, type JtiStore } from "./jti";
import type { GrantAuditClaims, GrantClaims, GrantVerifyBinding } from "./types";

/** 默认允许的时钟偏差（秒）。只放宽“刚过期/时间稍前”，不放宽 boot 与 iat 门槛。 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 5;

export interface GrantVerifierOptions {
  /** 本 cell id，必须与 claim.aud 一致。 */
  audience: string;
  /** 本 cell 的租户 id，必须与 claim.tid 一致（一个进程只服务一个租户）。 */
  tenantId: string;
  /** 本进程 bootId，必须与 claim.boot 一致。 */
  bootId: string;
  /** 本进程启动时刻（Unix 秒）；iat 早于它的凭证一律拒绝。 */
  startedAt: number;
  /** 允许的签发方。 */
  issuer: string;
  /** 已安装的验签公钥（JWKS 形态）。空集合 = 拒绝一切。 */
  keys: readonly GrantPublicJwk[];
  /** 注入时钟（秒）。 */
  clock?: GrantClock;
  /** 注入的一次性 jti 存储；不传则内部创建。 */
  jtiStore?: JtiStore;
  clockSkewSeconds?: number;
  /** 允许的最大有效期（秒），默认 60。 */
  maxTtlSeconds?: number;
}

export interface GrantVerifier {
  /** 校验并消费；成功返回凭证声明，失败抛 GrantError。 */
  verifyAndConsume(token: string, binding: GrantVerifyBinding): GrantClaims;
  /** 已安装的验签公钥集合的快照（诊断用）。 */
  keyset(): NormalizedKeyset;
  /** 一次性存储的当前指标（诊断用）。 */
  jtiStats(): ReturnType<JtiStore["stats"]>;
  /** 本 cell 的配置（诊断用，不含密钥材料）。 */
  readonly audience: string;
  readonly tenantId: string;
  readonly bootId: string;
  readonly issuer: string;
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GrantError("grant/signer-unavailable", `校验器配置缺失：${name}`);
  }
  return value;
}

function assertBinding(binding: GrantVerifyBinding): void {
  if (binding === null || typeof binding !== "object") {
    throw new GrantError("grant/invalid-claims", "缺少绑定参数");
  }
  if (!isGrantOperation(binding.op)) {
    throw new GrantError("grant/invalid-claims", "本次请求的 op 不合法", {
      allowed: GRANT_OPERATIONS.join("|"),
    });
  }
  if (typeof binding.cmd !== "string" || binding.cmd.length === 0) {
    throw new GrantError("grant/invalid-claims", "本次请求缺少 commandId");
  }
  if (typeof binding.bh !== "string" || binding.bh.length !== 64) {
    throw new GrantError("grant/invalid-claims", "本次请求缺少合法正文摘要");
  }
}

export function createGrantVerifier(options: GrantVerifierOptions): GrantVerifier {
  const audience = requireNonEmpty(options.audience, "audience");
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  const bootId = requireNonEmpty(options.bootId, "bootId");
  const issuer = requireNonEmpty(options.issuer, "issuer");
  if (!Number.isSafeInteger(options.startedAt) || options.startedAt < 0) {
    throw new GrantError("grant/signer-unavailable", "校验器配置缺失：startedAt（Unix 秒）");
  }
  const startedAt = options.startedAt;
  const clock = options.clock ?? systemClockSeconds;
  const clockSkew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const maxTtl = options.maxTtlSeconds ?? GRANT_TTL_SECONDS;
  if (!Number.isSafeInteger(clockSkew) || clockSkew < 0) {
    throw new GrantError("grant/signer-unavailable", "clockSkewSeconds 必须是非负整数", { clockSkewSeconds: clockSkew });
  }
  if (!Number.isSafeInteger(maxTtl) || maxTtl <= 0 || maxTtl > GRANT_TTL_SECONDS) {
    throw new GrantError("grant/signer-unavailable", `maxTtlSeconds 必须在 1..${GRANT_TTL_SECONDS} 之间`, { maxTtl });
  }

  // 构造即失败：公钥集合为空、非 P-256、kid 冲突都在这里拒绝，运行期不再“临时补救”。
  const keyset = normalizeKeyset(options.keys);
  const jtiStore = options.jtiStore ?? createJtiStore({ clock });

  function checkAlgorithmAndKey(header: { alg: string; kid: string; typ: string }): KeyObject {
    if (header.alg !== GRANT_ALG) {
      throw new GrantError("grant/unsupported-alg", `header.alg 必须是固定的 ${GRANT_ALG}`, {
        alg: header.alg === "" ? "缺失" : header.alg,
      });
    }
    if (header.typ !== "" && header.typ !== GRANT_TYP) {
      throw new GrantError("grant/malformed", `header.typ 必须是 ${GRANT_TYP}`, { typ: header.typ });
    }
    if (header.kid === "") {
      throw new GrantError("grant/key-id-missing", "header.kid 缺失，无法选钥");
    }
    return selectVerificationKey(keyset, header.kid);
  }

  function checkClaims(payload: Record<string, unknown>): GrantClaims {
    const claims: Record<string, string | number> = {};
    for (const name of [
      "iss",
      "aud",
      "boot",
      "tid",
      "sid",
      "sub",
      "wid",
      "preset",
      "rev",
      "cmd",
      "bh",
      "jti",
      "iat",
      "exp",
    ] as const) {
      claims[name] = readClaim(payload, name);
    }
    const op = payload["op"];
    if (!isGrantOperation(op)) {
      throw new GrantError("grant/invalid-claims", "claim op 不在允许的操作集合内", {
        claim: "op",
        allowed: GRANT_OPERATIONS.join("|"),
      });
    }
    return {
      iss: claims["iss"] as string,
      aud: claims["aud"] as string,
      boot: claims["boot"] as string,
      tid: claims["tid"] as string,
      sid: claims["sid"] as string,
      sub: claims["sub"] as string,
      wid: claims["wid"] as string,
      preset: claims["preset"] as string,
      rev: claims["rev"] as number,
      op,
      cmd: claims["cmd"] as string,
      bh: claims["bh"] as string,
      jti: claims["jti"] as string,
      iat: claims["iat"] as number,
      exp: claims["exp"] as number,
    };
  }

  function checkTime(claims: GrantClaims, now: number): void {
    if (claims.exp - claims.iat <= 0) {
      throw new GrantError("grant/invalid-claims", "exp 必须晚于 iat", { iat: claims.iat, exp: claims.exp });
    }
    if (claims.exp - claims.iat > maxTtl) {
      throw new GrantError("grant/invalid-claims", `凭证有效期不能超过 ${maxTtl}s`, {
        iat: claims.iat,
        exp: claims.exp,
      });
    }
    if (claims.iat > now + clockSkew) {
      throw new GrantError("grant/invalid-claims", "iat 在未来，拒绝", { iat: claims.iat, now });
    }
    if (claims.iat < startedAt) {
      throw new GrantError("grant/too-old", "iat 早于本进程启动时刻，拒绝重启前签发的凭证", {
        iat: claims.iat,
        startedAt,
      });
    }
    if (now - clockSkew >= claims.exp) {
      throw new GrantError("grant/expired", "凭证已过期", { exp: claims.exp, now, clockSkew });
    }
  }

  function checkBindings(claims: GrantClaims, binding: GrantVerifyBinding): void {
    if (claims.iss !== issuer) {
      throw new GrantError("grant/invalid-claims", "iss 不是允许的签发方", {
        claim: "iss",
        actual: claims.iss,
        expected: issuer,
      });
    }
    if (claims.aud !== audience) {
      throw new GrantError("grant/audience-mismatch", "aud 不是本 cell", {
        claim: "aud",
        actual: claims.aud,
        expected: audience,
      });
    }
    if (claims.tid !== tenantId) {
      throw new GrantError("grant/tenant-mismatch", "tid 不是本 cell 的租户", {
        claim: "tid",
        actual: claims.tid,
        expected: tenantId,
      });
    }
    if (claims.boot !== bootId) {
      throw new GrantError("grant/boot-mismatch", "boot 不是本进程的 bootId", {
        claim: "boot",
        actual: claims.boot,
        expected: bootId,
      });
    }
    if (claims.op !== binding.op) {
      throw new GrantError("grant/operation-mismatch", "op 与本次请求不一致", {
        claim: "op",
        actual: claims.op,
        expected: binding.op,
      });
    }
    if (claims.cmd !== binding.cmd) {
      throw new GrantError("grant/operation-mismatch", "cmd 与本次请求不一致", {
        claim: "cmd",
        actual: claims.cmd,
        expected: binding.cmd,
      });
    }
    if (claims.bh !== binding.bh) {
      throw new GrantError("grant/body-hash-mismatch", "bh 与请求正文摘要不一致", { claim: "bh" });
    }
  }

  return {
    audience,
    tenantId,
    bootId,
    issuer,

    verifyAndConsume(token: string, binding: GrantVerifyBinding): GrantClaims {
      assertBinding(binding);

      const decoded = decodeJwsCompact(token);
      const key = checkAlgorithmAndKey(decoded.header);

      let signatureOk = false;
      try {
        signatureOk = cryptoVerify(
          "sha256",
          Buffer.from(decoded.signingInput, "utf8"),
          { key, dsaEncoding: "ieee-p1363" },
          Buffer.from(decoded.signature),
        );
      } catch {
        // verify 抛错（签名长度不对、密钥异常）与验签失败同义：拒绝。
        signatureOk = false;
      }
      if (!signatureOk) {
        throw new GrantError("grant/bad-signature", "ES256 签名验证失败", { kid: decoded.header.kid });
      }

      const payload = decodePayloadObject(decoded.payload);
      const claims = checkClaims(payload);
      const now = clock();
      checkTime(claims, now);
      checkBindings(claims, binding);

      // 全部通过后才消费：失败请求不能烧掉合法凭证。
      jtiStore.consume(claims.jti);

      return Object.freeze(claims);
    },

    keyset(): NormalizedKeyset {
      return keyset;
    },

    jtiStats() {
      return jtiStore.stats();
    },
  };
}

/** 从声明里取审计快照（与 claims 同形，显式列出以冻结字段面）。 */
export function toAuditClaims(claims: GrantClaims): GrantAuditClaims {
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
