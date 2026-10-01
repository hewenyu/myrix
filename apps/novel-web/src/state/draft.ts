/**
 * 保存冲突的本地草稿：409 时必须留住用户输入，允许重新读取/对比/覆盖。
 * 绝不静默用服务端内容覆盖本地草稿。
 */
export interface DraftConflict {
  /** 本地未保存的内容。 */
  localText: string;
  /** 本地内容基于的版本（即提交时的 expectedVersion）。 */
  expectedVersion: number;
  /** 服务端当前版本（来自 409 响应体）。 */
  serverVersion: number;
  detectedAt: number;
}

export interface DraftState<T> {
  /**
   * 冻结的基线：本地文本所基于的服务端对象。
   * `save()` 永远提交 `base.version`，因此即使用户在编辑期间服务端推进了版本，
   * 也会得到 409 而不是静默覆盖。
   */
  base: T | null;
  /** 最近一次观测到的服务端对象；仅用于对比展示与显式采用。 */
  server: T | null;
  /** 编辑器当前文本，可能与 base 不同。 */
  text: string;
  /** 存在冲突时不为 null；本地草稿保留在 text 中。 */
  conflict: DraftConflict | null;
  /** 保存成功后的提示。 */
  notice: string | null;
}

/** 仅当文本与基线一致时才认为没有未保存修改。 */
export function isDirty<T extends { text: string; version: number }>(draft: DraftState<T>): boolean {
  if (!draft.base) return draft.text.trim().length > 0;
  return draft.text !== draft.base.text;
}

/** 服务端已有新版本，但用户尚未显式处理（不构成冲突，直到保存返回 409）。 */
export function hasNewerServerVersion<T extends { text: string; version: number }>(
  draft: DraftState<T>,
): boolean {
  if (!draft.base || !draft.server) return false;
  return draft.server.version !== draft.base.version;
}

export function initDraft<T extends { text: string; version: number }>(server: T): DraftState<T> {
  return { base: server, server, text: server.text, conflict: null, notice: null };
}

export function updateDraftText<T extends { text: string; version: number }>(
  draft: DraftState<T>,
  text: string,
): DraftState<T> {
  return { ...draft, text };
}

/**
 * 观测到新的服务端对象。
 *
 * - 没有未保存修改：直接采纳为新的基线与快照；
 * - 有未保存修改：**只更新快照**，基线保持不动，本地文本原样保留。
 *   这样后续保存会以旧版本号提交并由服务端返回 409，而不是静默覆盖别人的修改。
 *
 * 单调性：观测版本只增不减。基线或快照已经停在更高版本时，迟到的旧 GET 被
 * 整个忽略（不改变 text/base/server/notice），因此不会出现"回退到旧版本"的闪烁。
 *
 * 另：保存提示（"已保存为版本 N"）只在基线仍停在 N 时成立。服务端被
 * 别处（例如模型工具）推进到更新的版本后，旧的保存提示会与工具栏里的
 * "已保存版本" 自相矛盾，因此**只在版本未变时保留**。
 */
export function observeServer<T extends { text: string; version: number }>(
  draft: DraftState<T>,
  server: T,
): DraftState<T> {
  // 单调性：同一对象内已经知道的基线/观测版本都比这次观测新时，这是一次
  // 迟到的旧 GET（例如并发重读的 v1 落后于已保存/已观测的 v2）。忽略它，
  // 绝不回退文本、基线、观测或保存提示；dirty 时更不允许 server 被降级。
  const known = [draft.base?.version, draft.server?.version].filter(
    (version): version is number => typeof version === "number",
  );
  if (known.some((version) => server.version < version)) return draft;

  const dirty = isDirty(draft);
  const serverMovedPastBaseline = draft.base !== null && draft.base.version !== server.version;
  if (!dirty && !draft.conflict) {
    // 没有未保存修改：采纳服务端为新的基线。
    return {
      ...initDraft(server),
      notice: serverMovedPastBaseline ? null : draft.notice,
    };
  }
  return {
    ...draft,
    server,
    base: draft.base ?? server,
    notice: serverMovedPastBaseline ? null : draft.notice,
  };
}

export function markConflict<T extends { text: string; version: number }>(
  draft: DraftState<T>,
  serverVersion: number,
): DraftState<T> {
  return {
    ...draft,
    conflict: {
      localText: draft.text,
      expectedVersion: draft.base ? draft.base.version : 0,
      serverVersion,
      detectedAt: Date.now(),
    },
    notice: null,
  };
}

/**
 * 保存成功：提交时的快照成为**新的基线**，服务端确认的版本只推进这条已提交内容。
 *
 * 不变量：
 * - 等待响应期间用户继续输入时，**保留当前正文**（不能退回提交时的快照），
 *   它与推进后的基线不同，因此继续 dirty；没有继续输入则正常 clean；
 * - 已观测到的更高服务端版本**绝不回退**：迟到的 `v1` 不能覆盖 GET 观测到的 `v2`；
 * - 没有继续输入且已观测到更高版本时，采用该服务端快照（等价于干净编辑器采纳远端更新）；
 * - 有继续输入时保留草稿：`base` 停在已提交版本、`server` 停在观测版本，
 *   下一次保存仍以旧基线提交并得到 409（CAS 保护不丢）；
 * - 基线已经高于本次确认版本（等待响应期间用户显式采用了更新版本）时，
 *   这次确认是迟到的旧 ack，整个忽略：不清除新状态、不伪造 dirty。
 */
export function resolveSaved<T extends { text: string; version: number }>(
  draft: DraftState<T>,
  saved: { text: string; version: number },
): DraftState<T> {
  // 迟到的保存确认：基线已经被推进到比这次 ack 更高的版本（例如等待 v1
  // 响应期间用户显式 acceptServer(v2)）。旧的 ack 不得把基线/观测拉回去，
  // 也不得用提交时的旧文本覆盖当前草稿、伪造 dirty 或清除新状态。
  if (draft.base && draft.base.version > saved.version) return draft;

  const observed = draft.server;
  const observedIsNewer = observed !== null && observed.version > saved.version;
  const typedAfterSubmit = draft.text !== saved.text;

  // 保存推进的是“提交时那份内容”的基线，与服务端确认的版本绑定。
  const baseline = draft.base ? { ...draft.base, text: saved.text, version: saved.version } : null;

  if (observedIsNewer && !typedAfterSubmit) {
    // 没有更新的本地输入：可以采用已经观测到的更高版本（连同其正文）。
    return {
      base: observed,
      server: observed,
      text: observed.text,
      conflict: null,
      notice: null,
    };
  }

  const server =
    observed && !observedIsNewer
      ? { ...observed, text: saved.text, version: saved.version }
      : (observed ?? baseline);

  return {
    ...draft,
    base: baseline,
    server,
    text: typedAfterSubmit ? draft.text : saved.text,
    conflict: null,
    notice: `已保存为版本 ${saved.version}`,
  };
}

/**
 * 用户在冲突后选择“采用服务端内容”：显式丢弃本地草稿，必须由用户点击触发。
 */
export function acceptServer<T extends { text: string; version: number }>(
  _draft: DraftState<T>,
  server: T,
): DraftState<T> {
  return {
    ...initDraft(server),
    notice: `已采用服务端版本 ${server.version}，本地草稿已废弃`,
  };
}
