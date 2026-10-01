import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateSessionList, invalidateWorkBusinessQueries, useTurnRefresh } from "../src/state/useTurnRefresh";
import { workKeys } from "../src/state/useWorks";

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const WORK = "w-1";
const SESSION = "s-1";

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnRefresh", () => {
  it("只在持久终态计数推进时失效当前作品的业务 query（不碰作品列表）", async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { rerender } = renderHook(
      ({ settlements }: { settlements: number }) =>
        useTurnRefresh({ workId: WORK, sessionId: SESSION, settlements, connected: false }),
      { wrapper, initialProps: { settlements: 0 } },
    );

    // 初始基线不产生任何读取。
    expect(invalidate).not.toHaveBeenCalled();

    // 只有瞬态活动（计数不变）不触发。
    rerender({ settlements: 0 });
    expect(invalidate).not.toHaveBeenCalled();

    // 持久终态 +1 → 合并窗口后恰好失效一次。
    rerender({ settlements: 1 });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.outline(WORK));
    expect(keys).toContainEqual(workKeys.chapters(WORK));
    expect(keys).toContainEqual(["works", WORK, "bible"]);
    // 绝不失效作品列表，也不跨作品。
    expect(keys).not.toContainEqual(["works"]);
    expect(keys.every(key => !Array.isArray(key) || key[0] !== "works" || key[1] === WORK)).toBe(true);
  });

  it("同一次回放的多条终态在合并窗口内只读取一次", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ settlements }: { settlements: number }) =>
        useTurnRefresh({ workId: WORK, sessionId: SESSION, settlements, connected: false }),
      { wrapper, initialProps: { settlements: 0 } },
    );

    for (const settlements of [1, 2, 3, 4, 5]) rerender({ settlements });
    await vi.advanceTimersByTimeAsync(300);

    // 5 个终态（历史回放）合并成一次失效 → 每个 key 各一次，共 3 次。
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map(key => JSON.stringify(key))).size).toBe(3);
  });

  it("切换会话或作品会重新建立基线，迟到的合并窗口不会打到新作品上", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ sessionId, workId }: { sessionId: string; workId: string }) =>
        useTurnRefresh({ workId, sessionId, settlements: 0, connected: false }),
      { wrapper, initialProps: { sessionId: SESSION, workId: WORK } },
    );

    // 切到另一条会话：即便此时 settlements 计数与基线不同，也不应该对着新作品发失效。
    rerender({ sessionId: "s-2", workId: WORK });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate.mock.calls.every(([filters]) => (filters as { queryKey: unknown[] }).queryKey[1] === WORK)).toBe(true);

    invalidate.mockClear();
    rerender({ sessionId: "s-2", workId: "w-2" });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("切换会话时先看到旧流计数的下降：不把下降算完成，B 首轮恰好刷新一次", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ sessionId, settlements }: { sessionId: string; settlements: number }) =>
        useTurnRefresh({ workId: WORK, sessionId, settlements, connected: false }),
      { wrapper, initialProps: { sessionId: "s-A", settlements: 0 } },
    );

    // A 累计 4 个持久终态 → 合并窗口后一次失效。
    rerender({ sessionId: "s-A", settlements: 4 });
    await vi.advanceTimersByTimeAsync(300);
    expect(invalidate).toHaveBeenCalledTimes(3);
    invalidate.mockClear();

    // 选择 B 的那一帧 useSessionStream 的状态清空还晚一轮：这里仍看到 A 的计数 4。
    rerender({ sessionId: "s-B", settlements: 4 });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).not.toHaveBeenCalled();

    // 下一帧 B 重置为 0：这是归属改变，不是"完成"，绝不能把新基线钉在 4。
    rerender({ sessionId: "s-B", settlements: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).not.toHaveBeenCalled();

    // B 首轮终态 1：必须刷新一次（旧实现的基线停在 4，前三轮都不会刷）。
    rerender({ sessionId: "s-B", settlements: 1 });
    await vi.advanceTimersByTimeAsync(300);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toHaveLength(3);
    expect(keys).toContainEqual(workKeys.outline(WORK));
    expect(keys).toContainEqual(workKeys.chapters(WORK));
    expect(keys).toContainEqual(["works", WORK, "bible"]);
    // 始终只失效当前作品，不跨作品、不碰作品列表。
    expect(keys.every(key => !Array.isArray(key) || key[0] !== "works" || key[1] === WORK)).toBe(true);
  });

  it("计数下降会取消旧会话尚未触发的合并窗口，迟到的失效不打到新会话上", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ sessionId, settlements }: { sessionId: string; settlements: number }) =>
        useTurnRefresh({ workId: WORK, sessionId, settlements, connected: false }),
      { wrapper, initialProps: { sessionId: "s-A", settlements: 0 } },
    );

    // A 的终态排入合并窗口，但窗口还没到点就切走。
    rerender({ sessionId: "s-A", settlements: 2 });
    rerender({ sessionId: "s-B", settlements: 2 });
    rerender({ sessionId: "s-B", settlements: 0 });
    await vi.advanceTimersByTimeAsync(1000);

    // A 的窗口被取消；B 的计数下降只重建基线，不产生任何读取。
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("没有作品时不发失效请求", async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ settlements }: { settlements: number }) =>
        useTurnRefresh({ workId: null, sessionId: SESSION, settlements, connected: false }),
      { wrapper, initialProps: { settlements: 0 } },
    );
    rerender({ settlements: 1 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("事件流连接成功只刷新一次会话列表（真实的 creating→active 证据）", async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender } = renderHook(
      ({ connected }: { connected: boolean }) =>
        useTurnRefresh({ workId: WORK, sessionId: SESSION, settlements: 0, connected }),
      { wrapper, initialProps: { connected: false } },
    );

    expect(invalidate).not.toHaveBeenCalled();
    rerender({ connected: true });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(invalidate.mock.calls[0]?.[0]).toMatchObject({ queryKey: workKeys.sessions(WORK) });

    // 连接状态重复抖动不会重复刷新同一条会话。
    rerender({ connected: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("辅助函数使用的 key 前缀与 useWorkspace 的既有模式一致", () => {
    const { client } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateWorkBusinessQueries(client, WORK);
    invalidateSessionList(client, WORK);
    const keys = invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workKeys.sessions(WORK));
  });
});
