import type { NovelPreset } from "@myrix/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTransportState } from "./api/transport";
import { Banner } from "./components/common";
import { Icon } from "./components/Icon";
import { StatusBar } from "./components/StatusBar";
import { LoginPanel } from "./components/LoginPanel";
import { AssistantPanel } from "./panels/AssistantPanel";
import { WorkListPanel } from "./panels/WorkListPanel";
import { WorkspacePane } from "./panels/WorkspacePane";
import type { AuthSession } from "./api/endpoints";
import { useAuth } from "./state/useAuth";
import { useSessionStream } from "./state/useSessionStream";
import { useTurnRefresh } from "./state/useTurnRefresh";
import { useSessions } from "./state/useWorkspace";
import { useWorks } from "./state/useWorks";
import { describeRunState } from "./state/status";
import type { SelectionContext } from "./state/selectionContext";

/** 作品/会话原子选择；显式导航推进代际，迟到的异步回包不能抢走新选择。 */
export interface Selection { workId: string | null; sessionId: string | null; generation: number }
const EMPTY_SELECTION: Selection = { workId: null, sessionId: null, generation: 0 };

export function App() {
  const auth = useAuth();
  if (!auth.isAuthenticated) return <div className="app"><LoginPanel config={auth.config} loading={auth.isLoading}
    error={auth.isLoading ? null : (auth.sessionError ?? (auth.config ? null : "无法读取认证配置，请确认 BFF 已启动。"))}
    devLogin={auth.devLogin} devLoginPending={auth.devLoginPending} devLoginError={auth.devLoginError} loginWithOidc={auth.loginWithOidc} /></div>;
  return <Workspace session={auth.session} onLogout={auth.logout} logoutPending={auth.logoutPending} />;
}

function Workspace({ session, onLogout, logoutPending }: { session: AuthSession | undefined; onLogout: () => void; logoutPending: boolean }) {
  const worksState = useWorks();
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [editorDirty, setEditorDirty] = useState(false);
  const [composerDirty, setComposerDirty] = useState(false);
  const [mobilePane, setMobilePane] = useState("content");
  const [focused, setFocused] = useState(false);
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const committed = useRef(selection);
  useLayoutEffect(() => { committed.current = selection; }, [selection]);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const transport = useTransportState();
  const selectedWork = worksState.items.find((work) => work.id === selection.workId) ?? null;
  const sessionsState = useSessions(selection.workId);
  const stream = useSessionStream(selection.sessionId);
  const dirty = editorDirty || composerDirty;
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const leave = () => !dirty || window.confirm("还有未保存的正文或未发送的消息。离开会放弃这些内容，确定离开吗？");
  useTurnRefresh({ workId: selection.workId, sessionId: selection.sessionId, settlements: stream.settlements, connected: stream.connected });
  const runState = describeRunState({ hasSession: Boolean(selection.sessionId), connected: stream.connected, turnActive: stream.turnActive, turnOutcome: stream.turnOutcome, settledSeq: stream.settledSeq, serverStatus: stream.serverStatus, serverStatusSeq: stream.serverStatusSeq });
  const runtimeHint = !transport.reachable ? "网络暂时无法连接，当前展示最近读取的内容。" : stream.serverStatus === "model-not-configured" ? "服务端尚未配置可用模型。" : null;
  const selectWork = (workId: string | null) => {
    if (!leave()) return;
    setEditorDirty(false); setComposerDirty(false); setMobilePane("content");
    setSelection((prev) => ({ workId, sessionId: null, generation: prev.generation + 1 }));
  };

  return <div className={`app ${selection.workId ? "studio-app" : "shelf-app"}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Icon name="book" size={20} /></span><span>Myrix</span></div>
      {selection.workId ? <><span className="topbar-divider" /><button className="text-button back-button" type="button" onClick={() => selectWork(null)}><Icon name="back" size={16} />书架</button><span className="topbar-book" title={selectedWork?.title}>{selectedWork?.title ?? "正在打开书本…"}</span></> : <span className="brand-caption">给故事一个生长的地方</span>}
      <span className="spacer" />
      {selection.workId ? <button className="text-button focus-toggle" type="button" aria-pressed={focused} onClick={() => { setFocused(!focused); setMobilePane("content"); }}>{focused ? "退出专注" : "专注写作"}</button> : null}
      <details className="account-menu"><summary><span className="avatar">{session?.identity.displayName.slice(0, 1) || "我"}</span><span>{session?.identity.displayName || "我的账户"}</span></summary><StatusBar session={session} runtimeState={runState} modelConfigured={stream.serverStatus === "model-not-configured" ? false : null} onLogout={() => { if (leave()) onLogout(); }} logoutPending={logoutPending} /></details>
    </header>
    {worksState.removeError ? <Banner level="error">{worksState.removeError}</Banner> : null}
    {!selection.workId ? <WorkListPanel works={worksState.items} isLoading={worksState.isLoading} error={worksState.error} selectedWorkId={null}
      onSelect={selectWork}
      onCreate={async (input) => {
        const startGeneration = selection.generation;
        try {
          const work = await worksState.create(input);
          if (!mounted.current) return;
          setSelection((prev) => prev.generation === startGeneration ? { workId: work.id, sessionId: null, generation: prev.generation } : prev);
        } catch { /* mutation 展示原因并保留创建草稿 */ }
      }} createPending={worksState.createPending} createError={worksState.createError}
      onDelete={(workId) => { void worksState.remove(workId).catch(() => undefined); }} deletePending={worksState.removePending} onReload={() => void worksState.refetch()} /> : <>
      <nav className="mobile-switcher" aria-label="创作区域"><button type="button" aria-pressed={mobilePane === "directory"} onClick={() => setMobilePane("directory")}>目录</button><button type="button" aria-pressed={mobilePane === "content"} onClick={() => setMobilePane("content")}>正文</button><button type="button" aria-pressed={mobilePane === "assistant"} onClick={() => setMobilePane("assistant")}>助手</button></nav>
      <main className={`studio-layout${focused ? " is-focused" : ""}`} data-mobile-pane={mobilePane}>
        <WorkspacePane key={`workspace:${selection.workId}`} workId={selection.workId} workTitle={selectedWork?.title ?? null} onDirtyChange={setEditorDirty} onSelectionContextChange={setSelectionContext} onNavigateContent={() => setMobilePane("content")} />
        <AssistantPanel key={`assistant:${selection.workId}`} workId={selection.workId} sessions={sessionsState.items} sessionsLoading={sessionsState.isLoading} sessionsError={sessionsState.error}
          selectedSessionId={selection.sessionId} selectionContext={selectionContext?.workId === selection.workId ? selectionContext : null}
          onSelectSession={(sessionId) => setSelection((prev) => ({ ...prev, sessionId, generation: prev.generation + 1 }))}
          onNewConversation={() => setSelection((prev) => ({ ...prev, sessionId: null, generation: prev.generation + 1 }))}
          onCreateSession={async (preset: NovelPreset) => {
            const start = selection;
            if (!start.workId) return null;
            try {
              const created = await sessionsState.create(preset);
              if (!mounted.current || committed.current.generation !== start.generation || committed.current.workId !== start.workId || created.workId !== start.workId) return null;
              setSelection((prev) => prev.generation === start.generation && prev.workId === start.workId ? { ...prev, sessionId: created.id } : prev);
              return created.id;
            } catch { return null; }
          }} createPending={sessionsState.createPending} createError={sessionsState.createError}
          onArchiveSession={(sessionId, archived) => { void sessionsState.archive(sessionId, archived).then(() => {
            if (archived) setSelection((prev) => prev.sessionId === sessionId ? { ...prev, sessionId: null, generation: prev.generation + 1 } : prev);
          }, () => undefined); }} archivePending={sessionsState.archivePending} archiveError={sessionsState.archiveError}
          onDeleteSession={(sessionId) => { void sessionsState.remove(sessionId).then(() => setSelection((prev) => prev.sessionId === sessionId ? { ...prev, sessionId: null, generation: prev.generation + 1 } : prev), () => undefined); }}
          deletePending={sessionsState.removePending} deleteError={sessionsState.removeError} onReloadSessions={() => void sessionsState.refetch()} stream={stream} runtimeHint={runtimeHint} onDirtyChange={setComposerDirty} />
      </main>
    </>}
  </div>;
}
