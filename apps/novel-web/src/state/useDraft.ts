import type { SaveResult } from "@myrix/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ConflictError, describeError } from "../api/errors";
import {
  type DraftState,
  acceptServer,
  hasNewerServerVersion,
  initDraft,
  isDirty,
  markConflict,
  observeServer,
  resolveSaved,
  updateDraftText,
} from "./draft";

export interface DraftEditor<T extends { text: string; version: number }> {
  draft: DraftState<T> | null;
  /** 有未保存修改。 */
  dirty: boolean;
  /** 服务端已推进版本，但本地还有未保存内容（保存会得到 409 而不是静默覆盖）。 */
  serverAhead: boolean;
  conflict: DraftState<T>["conflict"];
  notice: string | null;
  saving: boolean;
  error: string | null;
  setText: (text: string) => void;
  save: (expectedVersion?: number) => Promise<SaveResult | null>;
  /** 重新读取服务端内容（保留本地草稿）。 */
  reloadServer: () => Promise<void>;
  /** 显式采用服务端内容（丢弃本地草稿，必须由用户点击）。 */
  takeServer: () => void;
  dismissNotice: () => void;
  clearError: () => void;
}

interface UseDraftOptions<T extends { text: string; version: number }> {
  /** 服务端当前内容；null 表示尚未加载。 */
  server: T | null;
  save: (input: { text: string; expectedVersion: number }) => Promise<SaveResult>;
  reload: () => Promise<unknown>;
  /** 标识切换（作品/章节/条目）时重置草稿。 */
  identity: string;
}

/**
 * 归属令牌。`identity` 每次切换（含 A→B→A 切回原对象）都推进 `generation`：
 * 只比较 ID 无法区分 A→B→A 里上一代 A 的回调与新一轮 A 的回调。
 */
interface Owner {
  identity: string;
  generation: number;
}

/**
 * 显式版本号的草稿编辑。
 *
 * 不变量：
 * - `save()` 永远提交本地基线版本，服务端因此能检测到并发修改；
 * - 服务端内容变化**不会**用新文本替换用户正在编辑的内容；
 * - 409 时把冲突写进状态并保留本地文本，等待用户显式选择；
 * - **归属隔离**：切换对象（`identity` 变化，含 A→B→A）时，**提交的第一帧**
 *   已经只属于新对象，绝不返回上一对象的 draft/saving/error；上一对象的在途
 *   保存/重读结果（成功、409、异常、finally）也绝不写入当前对象；
 * - **回调自持归属**：每个 mutator / save / reload 回调在创建它的那次 render 上
 *   快照自己的 `{identity, generation}`，调用时只认这个快照。旧回调即使被延迟到
 *   A→B→A 之后才调用，也不会把旧目标的正文发出去或改写新目标的状态；反之，
 *   在飞行的请求仍会把返回值交给原 caller（请求可能已被服务端接受，不能取消）。
 * - 共享 ref（已提交 owner / 已提交 draft / mounted）只在 commit 的
 *   `useLayoutEffect` 中更新：被放弃的并发 render 不会污染已提交值。
 */
export function useDraft<T extends { text: string; version: number }>({
  server,
  save,
  reload,
  identity,
}: UseDraftOptions<T>): DraftEditor<T> {
  const [owner, setOwner] = useState<Owner>(() => ({ identity, generation: 0 }));
  const [draft, setDraft] = useState<DraftState<T> | null>(() => (server ? initDraft(server) : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 对象切换在 **render 内**重建归属 state（React 官方的 "adjusting state when
   * props change" 模式）：React 会丢弃这次 render 的输出并立即用新 state 重渲染，
   * 因此**提交的第一帧**已经是新对象的 draft/saving/error，而不是上一对象的。
   * 这里只调用 setState，不写任何共享 ref —— 被放弃的并发 render 无法污染
   * 已提交的 ownerRef/draftRef。
   */
  if (owner.identity !== identity) {
    setOwner({ identity, generation: owner.generation + 1 });
    setDraft(server ? initDraft(server) : null);
    setSaving(false);
    setError(null);
  }

  /** 已提交的归属；只在 commit（useLayoutEffect）更新。 */
  const ownerRef = useRef(owner);
  /** 已提交的草稿；`performSave` 读取它作为本次提交的基线。 */
  const draftRef = useRef(draft);
  const mountedRef = useRef(true);
  /**
   * 当前 owner 在飞行的保存数，按 generation 记账。旧 owner 的 finally 既不能
   * 清掉新 owner 的 saving，也不能把新 owner 的计数减错。
   */
  const savingRef = useRef<{ generation: number; count: number }>({ generation: owner.generation, count: 0 });

  useLayoutEffect(() => {
    ownerRef.current = owner;
    draftRef.current = draft;
  });

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // identity 切换已在上面的 render 内重建 state；这里只观测**同一对象**内的
    // 服务端变化，不碰归属。
    setDraft((previous) => {
      if (!server) return previous;
      if (!previous) return initDraft(server);
      return observeServer(previous, server);
    });
  }, [identity, server]);

  /** 该令牌是否仍是已提交的归属（且组件仍挂载）。 */
  const isCurrent = useCallback(
    (token: Owner) =>
      mountedRef.current &&
      ownerRef.current.generation === token.generation &&
      ownerRef.current.identity === token.identity,
    [],
  );

  const setText = useCallback(
    (text: string) => {
      if (!isCurrent(owner)) return;
      setDraft((previous) => {
        if (!previous) return previous;
        return { ...updateDraftText(previous, text), notice: null };
      });
    },
    [owner, isCurrent],
  );

  const performSave = useCallback(
    async (expectedVersion?: number) => {
      // 本回调的归属快照：旧回调延迟到 A→B→A 调用时不得向旧目标发送。
      if (!isCurrent(owner)) return null;
      const current = draftRef.current;
      if (!current) return null;
      const token = owner;
      const textAtSave = current.text;
      const version = expectedVersion ?? current.base?.version ?? 0;
      const record = savingRef.current;
      savingRef.current =
        record.generation === token.generation
          ? { generation: token.generation, count: record.count + 1 }
          : { generation: token.generation, count: 1 };
      setSaving(true);
      setError(null);

      try {
        const result = await save({ text: textAtSave, expectedVersion: version });
        // 返回值仍交给原 caller；但只有仍是归属 owner 才允许写状态。
        if (isCurrent(token)) {
          setDraft((previous) => {
            if (!previous) return previous;
            if (result.status === "conflict") return markConflict(previous, result.version);
            return resolveSaved(previous, { text: textAtSave, version: result.version });
          });
        }
        return result;
      } catch (caught) {
        if (caught instanceof ConflictError) {
          if (isCurrent(token)) {
            setDraft((previous) => (previous ? markConflict(previous, caught.result.version) : previous));
          }
          return caught.result;
        }
        if (isCurrent(token)) setError(describeError(caught).message);
        return null;
      } finally {
        // 旧 owner 的 finally 不得清掉新 owner 的 saving；只减自己 generation 的账。
        if (isCurrent(token)) {
          const latest = savingRef.current;
          if (latest.generation === token.generation) {
            const next = Math.max(0, latest.count - 1);
            savingRef.current = { generation: token.generation, count: next };
            if (next === 0) setSaving(false);
          }
        }
      }
    },
    [owner, save, isCurrent],
  );

  const reloadServer = useCallback(async () => {
    if (!isCurrent(owner)) return;
    const token = owner;
    setError(null);
    try {
      await reload();
    } catch (caught) {
      // 切换对象后重读失败的晚到错误不得写到新对象上。
      if (isCurrent(token)) setError(describeError(caught).message);
    }
  }, [owner, reload, isCurrent]);

  const takeServer = useCallback(() => {
    if (!isCurrent(owner)) return;
    setDraft((previous) => (previous && previous.server ? acceptServer(previous, previous.server) : previous));
  }, [owner, isCurrent]);

  const dismissNotice = useCallback(() => {
    if (!isCurrent(owner)) return;
    setDraft((previous) => (previous ? { ...previous, notice: null } : previous));
  }, [owner, isCurrent]);

  const clearError = useCallback(() => {
    if (!isCurrent(owner)) return;
    setError(null);
  }, [owner, isCurrent]);

  return {
    draft,
    dirty: draft ? isDirty(draft) : false,
    serverAhead: draft ? hasNewerServerVersion(draft) : false,
    conflict: draft?.conflict ?? null,
    notice: draft?.notice ?? null,
    saving,
    error,
    setText,
    save: performSave,
    reloadServer,
    takeServer,
    dismissNotice,
    clearError,
  };
}
