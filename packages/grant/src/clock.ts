/**
 * 注入式时钟。
 *
 * 凭证的时效判定必须可测：进程启动门槛、60s TTL、时钟偏差都用同一只时钟。
 * 生产用 `systemClockSeconds`，测试用 `createManualClock`。
 */

/** Unix 秒。全包统一用秒，不用毫秒。 */
export type GrantClock = () => number;

export function systemClockSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface ManualClock {
  /** 当前 Unix 秒。 */
  now(): number;
  /** 前进 n 秒，返回新的当前时间。 */
  advance(seconds: number): number;
  /** 跳到某个绝对 Unix 秒。 */
  set(seconds: number): number;
}

/**
 * 手动时钟：只给测试与本地演示用。
 * 默认起点 2026-09-30T00:00:00Z。
 */
export function createManualClock(startSeconds = 1_790_000_000): ManualClock {
  let current = Math.floor(startSeconds);
  return {
    now: () => current,
    advance(seconds: number): number {
      current += Math.floor(seconds);
      return current;
    },
    set(seconds: number): number {
      current = Math.floor(seconds);
      return current;
    },
  };
}
