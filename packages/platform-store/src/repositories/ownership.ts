import { errors } from "../errors";
import type { StoreTx } from "../store";

/**
 * 作品归属的**事实校验**（不是策略判定）。
 *
 * 放在独立文件是为了避免 `bindings` ↔ `commands` 互相 import 形成环：
 * 两者都需要"这个作品属于调用者吗"。
 *
 * `loadOwnedWork` 把"不存在 / 已删除 / 不是你的"统一成 not_found，
 * 这样调用方探测他人作品 id 时得不到任何存在的证据。
 */

export interface OwnedWorkRef {
  owner_user_id: string;
  status: "active" | "archived" | "deleted";
}

export async function loadOwnedWork(
  tx: StoreTx,
  actorUserId: string,
  workId: string,
): Promise<OwnedWorkRef> {
  const work = await tx.trx
    .selectFrom("works")
    .select(["owner_user_id", "status"])
    .where("id", "=", workId)
    .executeTakeFirst();
  if (!work || work.status === "deleted") throw errors.notFound("work-not-found: 作品不存在");
  if (work.owner_user_id !== actorUserId) {
    throw errors.forbidden(
      "work-not-owned: 只有作品所有者能对该作品执行此操作（platform-plan-v2 D11：单一所有者）",
    );
  }
  return work;
}

export async function assertWorkOwned(tx: StoreTx, actorUserId: string, workId: string): Promise<void> {
  await loadOwnedWork(tx, actorUserId, workId);
}
