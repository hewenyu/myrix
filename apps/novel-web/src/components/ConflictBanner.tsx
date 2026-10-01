import type { DraftConflict } from "../state/draft";

export interface ConflictBannerProps {
  conflict: DraftConflict;
  serverText: string | null;
  serverVersion: number | null;
  onReload: () => void;
  onTakeServer: () => void;
  onSaveOverwrite: () => void;
  reloading: boolean;
  saving: boolean;
}

/**
 * 409 冲突处理面板。本地草稿永远保留在编辑器中，这里只提供三种显式选择：
 * 重新读取服务端、采用服务端内容（显式丢弃本地）、以服务端最新版本重新提交本地草稿。
 *
 * 后两者只在已读到不低于 `conflict.serverVersion` 的服务端快照时启用：409 只给出
 * 版本号，若本地快照仍是旧基线，用它会拿旧版本再提交一次，也会丢弃不该丢弃的内容。
 */
export function ConflictBanner({
  conflict,
  serverText,
  serverVersion,
  onReload,
  onTakeServer,
  onSaveOverwrite,
  reloading,
  saving,
}: ConflictBannerProps) {
  const canCompare = serverText !== null && serverVersion !== null;
  const differs = canCompare && serverText !== conflict.localText;
  // 409 只带来了版本号，没带来内容。冲突后本地快照可能仍是旧基线，此时
  // “采用服务端内容 / 以最新版本提交”都只会拿旧版本再提交一次，必须等重新读取到
  // 至少 conflict.serverVersion 的服务端快照后才允许（版本更高同样允许）。
  const hasFreshServer = canCompare && serverVersion >= conflict.serverVersion;

  return (
    <div className="banner is-warn" role="alert">
      <div>
        <strong>保存冲突：</strong>本地草稿基于版本 {conflict.expectedVersion}，服务端当前版本为{" "}
        {conflict.serverVersion}。本地未保存内容已保留，未被覆盖。
      </div>
      <div className="banner-actions">
        <button type="button" onClick={onReload} disabled={reloading}>
          {reloading ? "读取中…" : "重新读取服务端"}
        </button>
        <button
          type="button"
          onClick={onTakeServer}
          disabled={!hasFreshServer}
          title={
            hasFreshServer
              ? "显式丢弃本地草稿，改用服务端内容"
              : `尚未读取到服务端版本 ${conflict.serverVersion} 的内容，请先重新读取服务端`
          }
        >
          采用服务端内容
        </button>
        <button
          type="button"
          className="primary"
          onClick={onSaveOverwrite}
          disabled={!hasFreshServer || saving}
          title={
            hasFreshServer
              ? "以服务端最新版本号重新提交本地草稿"
              : `尚未读取到服务端版本 ${conflict.serverVersion} 的内容，请先重新读取服务端`
          }
        >
          {saving ? "提交中…" : "以最新版本提交本地草稿"}
        </button>
      </div>
      {canCompare && !hasFreshServer ? (
        <div className="small muted" style={{ marginTop: 8 }} role="status">
          本地仅有服务端版本 {serverVersion} 的旧快照，低于冲突报告的版本 {conflict.serverVersion}。
          请先点“重新读取服务端”，读取到最新内容后再选择采用服务端内容或重新提交；本地草稿会一直保留。
        </div>
      ) : null}
      {canCompare ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="small muted">
            {differs ? "服务端内容与本地草稿不同，对比：" : "服务端内容与本地草稿一致。"}
            {hasFreshServer
              ? null
              : `（下方服务端内容为版本 ${serverVersion} 的旧快照，不是冲突报告的最新版本 ${conflict.serverVersion}）`}
          </div>
          {differs ? (
            <div className="row" style={{ alignItems: "stretch", gap: 8 }}>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <div className="small muted">本地草稿（未保存）</div>
                <pre className="code">{conflict.localText}</pre>
              </div>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <div className="small muted">
                  {hasFreshServer ? `服务端版本 ${serverVersion}` : `服务端旧快照（版本 ${serverVersion}）`}
                </div>
                <pre className="code">{serverText}</pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
