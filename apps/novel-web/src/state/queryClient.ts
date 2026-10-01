import { QueryClient } from "@tanstack/react-query";

import { CellUnavailableError, ConflictError, NetworkError, UnauthorizedError } from "../api/errors";

/**
 * 重试策略：
 * - 401（会话失效）、409（版本冲突）不重试，交给 UI 处理；
 * - 503（cell 唤醒中）与网络故障重试，间隔指数退避。
 * 其它 4xx/5xx 只重试一次，避免把服务端错误放大成风暴。
 */
function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof ConflictError) return false;
  if (error instanceof CellUnavailableError) return failureCount < 5;
  if (error instanceof NetworkError) return failureCount < 3;
  return failureCount < 1;
}

function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof CellUnavailableError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000;
  }
  return Math.min(1000 * 2 ** attempt, 10_000);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry,
        retryDelay,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
