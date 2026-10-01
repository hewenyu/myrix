import type { NovelPreset } from "@myrix/contracts";
import { useState } from "react";

import { useTransportState } from "./api/transport";
import { Banner } from "./components/common";
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

/**
 * 作品与会话的**原子**选择状态。
 *
 * `workId` 与 `sessionId` 必须一起变更：旧作品的会话绝不能被新作品的界面选中，
 * 否则模型命令会打到另一个作品上（onCreate 作品成功只换 workId 的旧缺陷）。
 *
 * `generation` 是**用户显式选择**的代际：每次用户切作品 / 选会话 / 清空选择就 +1。
 * 异步回调在落地前核对 `prev.generation` 是否仍等于发起时的代际；
 * 自动选中（新建作品 / 新建会话的回包）不改代际，因此同一批等待中的请求仍可按序落地，
 * 但任何一个"用户显式选择"都能让它们作废——A→B→A 时旧回包不得偷选。
 */
export interface Selection {
  workId: string | null;
  sessionId: string | null;
  generation: number;
}

const EMPTY_SELECTION: Selection = { workId: null, sessionId: null, generation: 0 };

/** 顶层装配：登录门 → 三栏工作台。 */
export function App() {
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return (
      <div className="app">
        <LoginPanel
          config={auth.config}
          loading={auth.isLoading}
          error={
            auth.isLoading
              ? null
              : (auth.sessionError ??
                (auth.config ? null : "无法读取认证配置，请确认 BFF 已启动。"))
          }
          devLogin={auth.devLogin}
          devLoginPending={auth.devLoginPending}
          devLoginError={auth.devLoginError}
          loginWithOidc={auth.loginWithOidc}
        />
      </div>
    );
  }

  return <Workspace session={auth.session} onLogout={auth.logout} logoutPending={auth.logoutPending} />;
}

function Workspace({
  session,
  onLogout,
  logoutPending,
}: {
  session: AuthSession | undefined;
  onLogout: () => void;
  logoutPending: boolean;
}) {
  const worksState = useWorks();
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  // 事件回调与请求目标共享同一 render 的选择快照；只有提交后的回调才装配到界面。
  // 不在 render 写共享 ref，避免被放弃的并发 render 污染发起归属；落地仍核对 prev。
  const transport = useTransportState();

  const selectedWorkId = selection.workId;
  const selectedSessionId = selection.sessionId;

  const selectedWork = worksState.items.find((work) => work.id === selectedWorkId) ?? null;
  const sessionsState = useSessions(selectedWorkId);
  const stream = useSessionStream(selectedSessionId);

  // 持久回合结束后重新读取当前作品的业务缓存（有界、合并、只在持久终态触发）。
  // 模型可能通过工具写入作品内容；编辑器是否采用新文本仍由 useDraft 的脏草稿保护决定。
  useTurnRefresh({
    workId: selectedWorkId,
    sessionId: selectedSessionId,
    settlements: stream.settlements,
    connected: stream.connected,
  });

  // 模型配置状态只由服务端明确报告驱动；未报告就保持“未观测”。
  const modelConfigured = stream.serverStatus === "model-not-configured" ? false : null;

  // 运行态标签由持久事实推导（终态 / 进行中 / 连接生命周期），不把驱动瞬态帧当会话状态。
  const runState = describeRunState({
    hasSession: Boolean(selectedSessionId),
    connected: stream.connected,
    turnActive: stream.turnActive,
    turnOutcome: stream.turnOutcome,
    settledSeq: stream.settledSeq,
    serverStatus: stream.serverStatus,
    serverStatusSeq: stream.serverStatusSeq,
  });

  const runtimeHint = (() => {
    if (selectedSessionId && stream.serverStatus === "revoked") return "该会话已被服务端撤销，请新建会话。";
    if (selectedSessionId && stream.serverStatus === "waking") return "运行单元正在唤醒，命令已排队等待投递。";
    if (selectedSessionId && stream.serverStatus === "model-not-configured") {
      return "服务端报告未配置可用模型，助手暂时无法生成回复。";
    }
    if (selectedSessionId && stream.serverStatus === "interrupted") {
      return "上一轮被中断（进程可能重启过），请重试。";
    }
    if (!transport.reachable) return "无法连接 BFF，界面展示的是最近一次成功读取的数据。";
    return null;
  })();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span>Myrix 小说工作台</span>
          <small>作品 · 大纲 · 章节 · 设定 · 创作助手</small>
        </div>
      </header>

      <StatusBar
        session={session}
        runtimeState={runState}
        modelConfigured={modelConfigured}
        onLogout={onLogout}
        logoutPending={logoutPending}
      />

      {worksState.error ? (
        <Banner
          level="error"
          actions={<button type="button" onClick={() => void worksState.refetch()}>重试</button>}
        >
          {worksState.error}
        </Banner>
      ) : null}

      <main className="layout">
        <WorkListPanel
          works={worksState.items}
          isLoading={worksState.isLoading}
          error={worksState.error}
          selectedWorkId={selectedWorkId}
          onSelect={(workId) => {
            // 用户显式切作品：原子地换 work 并**清空会话**，代际 +1 让所有在途自动选中作废。
            setSelection((prev) => ({
              workId,
              sessionId: null,
              generation: prev.generation + 1,
            }));
          }}
          onCreate={(input) => {
            // 失败原因由 createError 承载并由列表面板展示。
            const startGeneration = selection.generation;
            worksState.create(input).then(
              (work) => {
                setSelection((prev) => {
                  // 期间用户做过显式选择（代际推进）：新作品不得抢走该选择。
                  if (prev.generation !== startGeneration) return prev;
                  // 新建作品清空会话：绝不让旧作品的 session 留在新作品界面上。
                  return { workId: work.id, sessionId: null, generation: prev.generation };
                });
              },
              () => undefined,
            );
          }}
          createPending={worksState.createPending}
          createError={worksState.createError}
          onDelete={(workId) => {
            worksState.remove(workId).then(
              () => {
                setSelection((prev) => {
                  // 功能性更新：只在当前选择仍确实指向被删作品时才清空，
                  // 因此迟到的旧回包不会清掉用户后来选的 B。
                  if (prev.workId !== workId) return prev;
                  return { workId: null, sessionId: null, generation: prev.generation + 1 };
                });
              },
              () => undefined,
            );
          }}
          deletePending={worksState.removePending}
          onReload={() => void worksState.refetch()}
        />

        {/* 按 workId 加 key：中栏的章节/草稿/检索等局部状态属于该作品实例，
            换作品时整体重建，旧作品的迟到回调不可能改到新作品的局部选择。
            key 必须在中栏/右栏之间唯一，否则 React 会把两个兄弟节点当成同一个。 */}
        <WorkspacePane
          key={`workspace:${selectedWorkId ?? "none"}`}
          workId={selectedWorkId}
          workTitle={selectedWork?.title ?? null}
        />

        {/* 右栏同样按 workId 隔离本地输入/预设：换作品不把旧作品正在输入的内容带过去。 */}
        <AssistantPanel
          key={`assistant:${selectedWorkId ?? "none"}`}
          workId={selectedWorkId}
          sessions={sessionsState.items}
          sessionsLoading={sessionsState.isLoading}
          sessionsError={sessionsState.error}
          selectedSessionId={selectedSessionId}
          onSelectSession={(sessionId) => {
            // 用户显式选会话：代际 +1，使在途的 createSession 回包不再自动选中。
            setSelection((prev) => ({
              ...prev,
              sessionId,
              generation: prev.generation + 1,
            }));
          }}
          onCreateSession={(preset: NovelPreset) => {
            const startWorkId = selection.workId;
            const startGeneration = selection.generation;
            if (!startWorkId) return;
            sessionsState.create(preset).then(
              (created) => {
                setSelection((prev) => {
                  // 只有发起时的 work 仍是当前 work、且期间没有用户显式选择，才自动选新会话。
                  if (prev.workId !== startWorkId) return prev;
                  if (prev.generation !== startGeneration) return prev;
                  // 回包必须确实属于发起它的作品（服务端授权边界不在此改动）。
                  if (created.workId !== startWorkId) return prev;
                  return { ...prev, sessionId: created.id };
                });
              },
              () => undefined,
            );
          }}
          createPending={sessionsState.createPending}
          createError={sessionsState.createError}
          onDeleteSession={(sessionId) => {
            sessionsState.remove(sessionId).then(
              () => {
                setSelection((prev) => {
                  // 撤销成功只在当前仍选中该会话时清空；迟到的旧回包不动新选的 sid。
                  if (prev.sessionId !== sessionId) return prev;
                  return { ...prev, sessionId: null, generation: prev.generation + 1 };
                });
              },
              () => undefined,
            );
          }}
          deletePending={sessionsState.removePending}
          onReloadSessions={() => void sessionsState.refetch()}
          stream={stream}
          runtimeHint={runtimeHint}
        />
      </main>
    </div>
  );
}
