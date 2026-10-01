/**
 * 进程内一次性 `jti` 存储。
 *
 * 语义（tech-design-v1 §3.1、platform-plan-v2 §3.1）：
 * - `jti` 只在本进程内保证一次性；进程重启后 `boot` 与 `iat` 门槛会拒掉旧凭证。
 * - 消费必须发生在签名、全部绑定校验（aud/tid/boot/op/cmd/bh/iat/exp/iss）与业务前置校验
 *   **全部成功之后**；任何一步失败都不能消费，否则一次失败请求就能把合法凭证“烧掉”，
 *   变成可用性攻击面。
 * - 过期的记录要及时清掉，否则 60s 一个进程会被 jti 撑爆内存。
 */
import { GrantError } from "./errors";
import type { GrantClock } from "./clock";

export interface JtiStoreOptions {
  /** 记录留存时长（秒）。必须 ≥ 凭证最大 TTL，默认 120s。 */
  retentionSeconds?: number;
  /** 记录条数上限，防止异常流量把内存打满；超限先清过期，仍超限则拒绝消费。 */
  maxEntries?: number;
  /** 注入时钟。 */
  clock: GrantClock;
}

export interface JtiStoreStats {
  size: number;
  consumed: number;
  rejectedFull: number;
  evicted: number;
}

export interface JtiStore {
  /** 是否已消费过。 */
  has(jti: string): boolean;
  /** 消费一次；已消费则抛 `grant/replayed`。 */
  consume(jti: string): void;
  /** 已消费的 jti 数量（未过期 + 未清理）。 */
  size(): number;
  stats(): JtiStoreStats;
  /** 清空全部记录（仅用于测试与显式重置）。 */
  reset(): void;
}

const DEFAULT_RETENTION_SECONDS = 120;
const DEFAULT_MAX_ENTRIES = 100_000;

export function createJtiStore(options: JtiStoreOptions): JtiStore {
  const retention = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isFinite(retention) || retention <= 0) {
    throw new GrantError("grant/signer-unavailable", "jti 留存时长必须是正数", { retentionSeconds: retention });
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new GrantError("grant/signer-unavailable", "jti 条数上限必须是正整数", { maxEntries });
  }

  const expiresAt = new Map<string, number>();
  let consumed = 0;
  let rejectedFull = 0;
  let evicted = 0;

  function evictExpired(now: number): void {
    for (const [jti, expiry] of expiresAt) {
      if (expiry <= now) {
        expiresAt.delete(jti);
        evicted += 1;
      }
    }
  }

  function isConsumed(jti: string): boolean {
    const expiry = expiresAt.get(jti);
    if (expiry === undefined) return false;
    if (expiry <= options.clock()) {
      expiresAt.delete(jti);
      evicted += 1;
      return false;
    }
    return true;
  }

  return {
    has: isConsumed,

    consume(jti: string): void {
      const now = options.clock();
      if (isConsumed(jti)) {
        throw new GrantError("grant/replayed", "jti 已被消费（重放）", { jti });
      }
      if (expiresAt.size >= maxEntries) {
        evictExpired(now);
        if (expiresAt.size >= maxEntries) {
          rejectedFull += 1;
          throw new GrantError("grant/replayed", "jti 记录已达上限，拒绝消费", { size: expiresAt.size, maxEntries });
        }
      }
      expiresAt.set(jti, now + retention);
      consumed += 1;
    },

    size(): number {
      return expiresAt.size;
    },

    stats(): JtiStoreStats {
      return { size: expiresAt.size, consumed, rejectedFull, evicted };
    },

    reset(): void {
      expiresAt.clear();
      consumed = 0;
      rejectedFull = 0;
      evicted = 0;
    },
  };
}
