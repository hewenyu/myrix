/**
 * 版本化写入（CAS）的纯判定：章节、大纲、设定共用同一套规则。
 *
 * 规则来自 tech-design-v1 §3.5 / first-version.md 接口基线：
 *   expectedVersion == currentVersion
 *     → "append"：写新版本
 *   currentVersion.parentVersion == expectedVersion
 *     且 currentVersion.contentHash == incomingHash
 *     → "duplicate"：这是同一次写入的重试，返回已有版本，不产生新版本
 *   其他情况
 *     → "conflict"：调用方必须重新读取最新版本再改
 *
 * 为什么需要 duplicate 分支：崩溃恢复后 DSH 会合成 closer 关掉中断的轮次，
 * 模型看到"结果未知"可能换个 callId 重试 [源码]。如果只有"版本号相等才写"，
 * 重试会因为版本号已经变了而永远冲突；如果盲目接受，又会写出重复正文。
 *
 * 这是纯函数：不碰数据库、不读时钟。数据库行锁（SELECT ... FOR UPDATE）负责
 * 防竞态，本函数只负责"给定当前状态，这次写入应该是什么结果"。
 */

export type VersionedWriteEffect = "append" | "duplicate" | "conflict";

export interface VersionedState {
  /** 当前版本号；0 表示"无内容"（对象已存在但从未写入过） */
  currentVersion: number;
  /** 当前版本记录的父版本；version 0 时为 null */
  currentParentVersion: number | null;
  /** 当前版本正文的服务端哈希 */
  currentContentHash: string;
}

export interface VersionedWriteRequest {
  expectedVersion: number;
  /** 服务端计算的本次正文哈希（sha256 hex） */
  incomingHash: string;
}

export type VersionedWriteDecision =
  | { effect: "append"; nextVersion: number; reason: string }
  | { effect: "duplicate"; version: number; reason: string }
  | { effect: "conflict"; currentVersion: number; reason: string };

export function decideVersionedWrite(
  state: VersionedState,
  request: VersionedWriteRequest,
): VersionedWriteDecision {
  const { currentVersion, currentParentVersion, currentContentHash } = state;
  const { expectedVersion, incomingHash } = request;

  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return {
      effect: "conflict",
      currentVersion,
      reason: `expectedVersion 必须是 >= 0 的整数，收到 ${String(expectedVersion)}`,
    };
  }

  if (expectedVersion === currentVersion) {
    return {
      effect: "append",
      nextVersion: currentVersion + 1,
      reason: `expectedVersion(${expectedVersion}) 等于当前版本，追加为新版本 ${currentVersion + 1}`,
    };
  }

  // 重试判定：当前版本是由 expectedVersion 直接演化来的，且正文完全相同
  if (
    currentVersion > 0 &&
    currentParentVersion === expectedVersion &&
    currentContentHash === incomingHash
  ) {
    return {
      effect: "duplicate",
      version: currentVersion,
      reason:
        `当前版本 ${currentVersion} 的父版本等于 expectedVersion(${expectedVersion}) 且正文哈希一致，` +
        "判定为同一次写入的重试，返回已有版本",
    };
  }

  const hashNote =
    currentParentVersion === expectedVersion
      ? `父版本匹配但正文哈希不同（current=${short(currentContentHash)} incoming=${short(incomingHash)}）`
      : `父版本(${String(currentParentVersion)})不等于 expectedVersion`;
  return {
    effect: "conflict",
    currentVersion,
    reason: `版本冲突：当前版本 ${currentVersion}，${hashNote}`,
  };
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

/** duplicate 时也要校验调用方声明的哈希与"服务端算出来的"一致；不一致一律 conflict */
export function assertHashShape(hash: string, field = "contentHash"): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`myrix: ${field} 必须是 64 位小写 hex 的 sha256，收到 ${JSON.stringify(hash)}`);
  }
}
