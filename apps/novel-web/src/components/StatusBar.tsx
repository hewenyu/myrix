import type { AuthSession } from "../api/endpoints";
import { useTransportState } from "../api/transport";
import type { StatusLabel } from "../state/status";
import { StatusPill } from "./common";

export interface StatusBarProps {
  session: AuthSession | undefined;
  /**
   * 运行态标签，由持久事实推导（见 `describeRunState`，在 App 里计算）。
   *
   * 刻意传**已推导好的标签**而不是原始 status 字符串：运行标签必须反映
   * "持久终态 / 进行中 / 连接生命周期"，不能把驱动瞬态帧（stream-start）当成会话状态。
   */
  runtimeState: StatusLabel | null;
  /** 是否检测到“模型未配置”。 */
  modelConfigured: boolean | null;
  onLogout: () => void;
  logoutPending: boolean;
}

/**
 * 状态条：登录、网络/BFF 可达性、唤醒与运行态、模型配置、事件流连接。
 * 每个取值都来自真实响应或事件；未知就显示“未知”，不伪装成正常。
 */
export function StatusBar({ session, runtimeState, modelConfigured, onLogout, logoutPending }: StatusBarProps) {
  const transport = useTransportState();

  return (
    <div className="statusbar" role="status" aria-label="系统状态">
      <StatusPill
        label="登录"
        value={
          session
            ? `${session.identity.displayName}（${session.identity.role === "admin" ? "管理员" : "成员"}）· 租户 ${session.identity.tenantId}`
            : "未登录"
        }
        level={session ? "ok" : "warn"}
      />
      <StatusPill
        label="认证模式"
        value={session ? (session.mode === "development" ? "开发模式（loopback）" : "OIDC") : "未知"}
        level={session?.mode === "development" ? "warn" : "info"}
      />
      <StatusPill
        label="网络"
        value={
          transport.reachable
            ? transport.lastOkAt
              ? `BFF 可达（${new Date(transport.lastOkAt).toLocaleTimeString("zh-CN", { hour12: false })}）`
              : "BFF 可达"
            : `无法连接 BFF${transport.lastError ? `：${transport.lastError}` : ""}`
        }
        level={transport.reachable ? "ok" : "error"}
      />
      <StatusPill
        label="运行"
        value={runtimeState ? runtimeState.text : "无进行中的会话"}
        level={runtimeState ? runtimeState.level : "info"}
      />
      <StatusPill
        label="模型"
        value={modelConfigured === null ? "未观测到模型配置状态" : modelConfigured ? "已配置" : "未配置（服务端报告）"}
        level={modelConfigured === null ? "info" : modelConfigured ? "ok" : "error"}
        title="模型缺失只在服务端明确报告时显示为未配置"
      />
      <StatusPill
        label="事件流"
        value={transport.streamConnected ? "已连接" : "未连接"}
        level={transport.streamConnected ? "ok" : "info"}
      />
      <span className="spacer" style={{ flex: 1 }} />
      {session ? (
        <button type="button" onClick={onLogout} disabled={logoutPending}>
          {logoutPending ? "退出中…" : "退出登录"}
        </button>
      ) : null}
    </div>
  );
}
