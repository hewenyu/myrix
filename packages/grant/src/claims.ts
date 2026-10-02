/**
 * 授权凭证的 claim 表与取值约束。
 *
 * 设计：每个 claim 用一条显式规则描述“怎么读、允许什么、报什么错”，
 * 校验器只是遍历这张表，所以“每个 claim 的错误值”都能被单测穷举。
 *
 * claim 全集（tech-design-v1 §3.1）：
 *   iss aud boot tid sid sub wid preset rev op cmd bh jti iat exp
 *
 * 额外收紧（本包决定，见 ADR-0010）：
 * - 不认识的 header 字段不参与任何判定；不认识的 claim 保留但忽略（前向兼容）。
 * - 所有标识符都走同一套 id 规则：不能有空白、不能有控制字符，长度 ≤ 128。
 *   `sid`/`sub`/`wid`/`cmd`/`jti` 额外禁止 `.`，避免将来做复合键时产生歧义。
 */
import { isSha256Hex } from "./sha256";
import { GrantError } from "./errors";

export const GRANT_ALG = "ES256" as const;
export const GRANT_TYP = "JWT" as const;
/** 凭证有效期：60 秒，作为 issueGrant 的默认值。 */
export const GRANT_TTL_SECONDS = 60;

export const GRANT_OPERATIONS = ["create", "resume", "send", "cancel", "subscribe"] as const;
export type GrantOperation = (typeof GRANT_OPERATIONS)[number];

export function isGrantOperation(value: unknown): value is GrantOperation {
  return typeof value === "string" && (GRANT_OPERATIONS as readonly string[]).includes(value);
}

export type GrantAction = "issue" | "verifyAndConsume";
export type GrantBindingCheck = "aud" | "tid" | "boot" | "op" | "cmd" | "bh" | "iat" | "exp" | "jti" | "iss" | "nbf";
export type ClaimTypeName = "string" | "identifier" | "digest" | "integer" | "timestamp";

export interface ClaimSpec {
  readonly name: string;
  readonly type: ClaimTypeName;
  /** 该 claim 参与校验的时机。 */
  readonly verifiedAt: readonly GrantAction[];
  /** 该 claim 是否会被写入审计/日志；密钥类 claim 永不记录。 */
  readonly audit: boolean;
  readonly describe: string;
}

const ANY_ACTION = ["issue", "verifyAndConsume"] as const;

/** claim 表；顺序仅用于错误报告时的稳定遍历。 */
export const CLAIM_SPECS: readonly ClaimSpec[] = [
  { name: "iss", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "签发方，必须等于配置的 expectedIssuer" },
  { name: "aud", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "受众 cellId，必须等于本 cell" },
  { name: "boot", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "cell 当前 bootId，必须等于本进程" },
  { name: "tid", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "租户 id，必须等于本 cell 租户" },
  { name: "sid", type: "identifier", verifiedAt: ANY_ACTION, audit: true, describe: "会话 id" },
  { name: "sub", type: "identifier", verifiedAt: ANY_ACTION, audit: true, describe: "所有者用户 id" },
  { name: "wid", type: "identifier", verifiedAt: ANY_ACTION, audit: true, describe: "作品 id" },
  { name: "preset", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "agent preset id" },
  { name: "rev", type: "integer", verifiedAt: ANY_ACTION, audit: true, describe: "策略/撤权版本，非负整数" },
  { name: "op", type: "string", verifiedAt: ANY_ACTION, audit: true, describe: "操作，取值见 GRANT_OPERATIONS" },
  { name: "cmd", type: "identifier", verifiedAt: ANY_ACTION, audit: true, describe: "commandId，绑定业务幂等键" },
  { name: "bh", type: "digest", verifiedAt: ANY_ACTION, audit: true, describe: "请求体 SHA-256（小写十六进制）" },
  { name: "jti", type: "identifier", verifiedAt: ANY_ACTION, audit: true, describe: "一次性凭证 id，进程内消费一次" },
  { name: "iat", type: "timestamp", verifiedAt: ANY_ACTION, audit: true, describe: "签发时间（Unix 秒）" },
  { name: "exp", type: "timestamp", verifiedAt: ANY_ACTION, audit: true, describe: "过期时间（Unix 秒），必须晚于 iat 且 ≤ 60s" },
];

/** 已知 claim 名集合；未知 claim 会被忽略而不是报错。 */
export const KNOWN_CLAIMS: ReadonlySet<string> = new Set(CLAIM_SPECS.map((spec) => spec.name));

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_STRING_LENGTH = 128;
// oxlint-disable-next-line no-control-regex -- 该正则就是控制字符黑名单本身：标识符安全过滤（fail-closed），不是笔误。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DOT_FREE_IDENTIFIERS = new Set(["sid", "sub", "wid", "cmd", "jti"]);

/** 标识符：可见字符、无空白、无控制字符、长度受限。 */
export function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (/\s/.test(value)) return false;
  return true;
}

export function isPlainString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_STRING_LENGTH) return false;
  return !CONTROL_CHARS.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function describeActual(value: unknown): string {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (typeof value === "number") return `number(${value})`;
  if (typeof value === "string") return `string(长度 ${value.length})`;
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 读取一个 claim 并按规格校验类型；失败抛 `grant/invalid-claims`。 */
export function readClaim(payload: Record<string, unknown>, name: string): string | number {
  const spec = CLAIM_SPECS.find((entry) => entry.name === name);
  if (!spec) throw new GrantError("grant/invalid-claims", `未知 claim：${name}`, { claim: name });
  const value = payload[name];
  switch (spec.type) {
    case "string":
    case "identifier": {
      if (!isPlainString(value)) {
        throw new GrantError("grant/invalid-claims", `claim ${name} 必须是非空字符串`, {
          claim: name,
          actual: describeActual(value),
        });
      }
      if (spec.type === "identifier") {
        if (!isIdentifier(value)) {
          throw new GrantError("grant/invalid-claims", `claim ${name} 不是合法标识符`, {
            claim: name,
            actual: describeActual(value),
          });
        }
        if (DOT_FREE_IDENTIFIERS.has(name) && value.includes(".")) {
          throw new GrantError("grant/invalid-claims", `claim ${name} 不能包含 "."`, { claim: name });
        }
      }
      return value;
    }
    case "digest": {
      if (!isSha256Hex(value)) {
        throw new GrantError("grant/invalid-claims", `claim ${name} 必须是 64 位小写十六进制 SHA-256`, {
          claim: name,
          actual: describeActual(value),
        });
      }
      return value;
    }
    case "integer": {
      if (!isNonNegativeInteger(value)) {
        throw new GrantError("grant/invalid-claims", `claim ${name} 必须是非负安全整数`, {
          claim: name,
          actual: describeActual(value),
        });
      }
      return value;
    }
    case "timestamp": {
      if (!isNonNegativeInteger(value)) {
        throw new GrantError("grant/invalid-claims", `claim ${name} 必须是 Unix 秒（非负安全整数）`, {
          claim: name,
          actual: describeActual(value),
        });
      }
      if (value > 4_102_444_800) {
        // 2100-01-01：再往后多半是毫秒误传或伪造。
        throw new GrantError("grant/invalid-claims", `claim ${name} 超出合理时间范围`, { claim: name, actual: value });
      }
      return value;
    }
    default: {
      const exhaustive: never = spec.type;
      throw new GrantError("grant/invalid-claims", `未支持的 claim 类型：${String(exhaustive)}`, { claim: name });
    }
  }
}
