import type { AuthConfig, AuthSession, DevUser } from "../api/endpoints";
import { auth } from "../api/endpoints";
import { UnauthorizedError, describeError } from "../api/errors";
import { clearCsrfToken, setCsrfToken } from "../api/csrf";
import { resetTransportState } from "../api/transport";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const authKeys = {
  config: ["auth", "config"] as const,
  session: ["auth", "session"] as const,
};

export interface AuthState {
  config: AuthConfig | undefined;
  session: AuthSession | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** 认证探测失败原因：未登录时为 null，网络/服务端故障时给出真实原因。 */
  sessionError: string | null;
  /** 生产 OIDC 模式下点击登录会整页跳转，不经过前端。 */
  loginWithOidc: () => void;
  devLogin: (user: DevUser) => void;
  devLoginPending: boolean;
  devLoginError: string | null;
  logout: () => void;
  logoutPending: boolean;
}

export function useAuth(): AuthState {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: authKeys.config,
    queryFn: ({ signal }) => auth.config(signal),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const sessionQuery = useQuery({
    queryKey: authKeys.session,
    queryFn: async ({ signal }) => {
      try {
        const session = await auth.session(signal);
        setCsrfToken(session.csrfToken);
        return session;
      } catch (error) {
        clearCsrfToken();
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: true,
  });

  const devLoginMutation = useMutation({
    mutationFn: (user: DevUser) => auth.devLogin(user),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken);
      queryClient.setQueryData(authKeys.session, session);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => auth.logout(),
    onSettled: () => {
      clearCsrfToken();
      resetTransportState();
      // 服务端已失效会话；清掉所有缓存并重取认证状态（会得到 401，回到登录门）。
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: authKeys.session });
    },
  });

  const session = sessionQuery.data;
  const isUnauthorized = sessionQuery.error instanceof UnauthorizedError;
  const sessionError = sessionQuery.error && !isUnauthorized ? describeError(sessionQuery.error).message : null;

  return {
    config: configQuery.data,
    session: isUnauthorized ? undefined : session,
    isLoading: configQuery.isLoading || (sessionQuery.isLoading && !isUnauthorized),
    isAuthenticated: Boolean(session) && !isUnauthorized,
    sessionError,
    loginWithOidc: () => {
      const loginUrl = configQuery.data?.loginUrl;
      if (loginUrl) window.location.assign(loginUrl);
    },
    devLogin: (user) => devLoginMutation.mutate(user),
    devLoginPending: devLoginMutation.isPending,
    devLoginError: devLoginMutation.error instanceof Error ? devLoginMutation.error.message : null,
    logout: () => logoutMutation.mutate(),
    logoutPending: logoutMutation.isPending,
  };
}
