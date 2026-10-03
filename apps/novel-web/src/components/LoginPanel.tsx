import type { AuthConfig } from "../api/endpoints";
import { Banner } from "./common";

export interface LoginPanelProps {
  config: AuthConfig | undefined;
  loading: boolean;
  error: string | null;
  devLogin: (user: "author" | "editor" | "other-tenant") => void;
  devLoginPending: boolean;
  devLoginError: string | null;
  loginWithOidc: () => void;
}

/**
 * 登录入口。
 *
 * - 生产只暴露 OIDC 跳转；
 * - 仅当 `GET /auth/config` 明确返回 `mode: "development"` 时，才显示三个种子测试身份，
 *   且不提供任意用户 ID 输入框。开发模式的身份只由服务端在 loopback 下签发。
 */
export function LoginPanel({
  config,
  loading,
  error,
  devLogin,
  devLoginPending,
  devLoginError,
  loginWithOidc,
}: LoginPanelProps) {
  const isDevelopment = config?.mode === "development";

  return (
    <section className="login" aria-label="登录">
      <p className="eyebrow">MYRIX · 写作空间</p>
      <h1>让故事，慢慢生长。</h1>
      <p className="muted small">从一个想法，到一整本书。登录你的书架，与创作 Agent 一起写下下一页。</p>

      {loading ? <p className="muted small">正在读取认证配置…</p> : null}
      {error ? <Banner level="error">{error}</Banner> : null}

      {!loading && config ? (
        <>
          {isDevelopment ? <Banner level="warn">开发模式：仅限本机测试，身份由服务端签发。</Banner> : null}

          {isDevelopment ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <strong className="small">测试身份（服务端预置，仅供开发）</strong>
              <div className="row">
                <button type="button" disabled={devLoginPending} onClick={() => devLogin("author")}>
                  作者 author
                </button>
                <button type="button" disabled={devLoginPending} onClick={() => devLogin("editor")}>
                  编辑 editor
                </button>
                <button type="button" disabled={devLoginPending} onClick={() => devLogin("other-tenant")}>
                  其它租户 other-tenant
                </button>
              </div>
              {devLoginError ? <Banner level="error">{devLoginError}</Banner> : null}
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 12 }}>
              <button type="button" className="primary" onClick={loginWithOidc}>
                登录我的书架
              </button>
            </div>
          )}
        </>
      ) : null}

      {!loading && !config && !error ? <Banner level="error">未能读取认证配置。</Banner> : null}
    </section>
  );
}
