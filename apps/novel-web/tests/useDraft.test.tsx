import type { Outline, SaveResult } from "@myrix/contracts";
import { act, configure, render, renderHook, waitFor } from "@testing-library/react";
import { Suspense, startTransition, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConflictError } from "../src/api/errors";
import { type DraftEditor, useDraft } from "../src/state/useDraft";

/**
 * 真实开启 React StrictMode：宿主在开发期也会用它包裹应用，双调用 render 与
 * effect 会暴露“在 render 里写共享 ref”“归属只在 passive effect 更新”这类 bug。
 * 这里不做任何 React 内部 mock。vitest 按文件隔离模块，该配置只作用于本文件。
 */
configure({ reactStrictMode: true });

const outline: Outline = { workId: "w1", text: "初始大纲", version: 2, updatedAt: "2026-01-01T00:00:00.000Z" };

describe("useDraft", () => {
  it("载入服务端内容作为基线，并识别未保存修改", async () => {
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save: async () => ({ status: "saved", version: 3 }),
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.dirty).toBe(false);

    act(() => result.current.setText("修改后的大纲"));
    expect(result.current.dirty).toBe(true);
  });

  it("保存时提交 expectedVersion 并采用服务端返回的新版本", async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ status: "saved", version: 5 }));
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save,
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("新内容"));
    await act(async () => {
      await result.current.save();
    });

    expect(save).toHaveBeenCalledWith({ text: "新内容", expectedVersion: 2 });
    expect(result.current.draft?.base?.version).toBe(5);
    expect(result.current.dirty).toBe(false);
    expect(result.current.notice).toBe("已保存为版本 5");
  });

  it("409：保留本地草稿、记录冲突，且不用服务端内容覆盖", async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ status: "conflict", version: 9 }));
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save,
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("我的本地草稿"));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.conflict).toMatchObject({ expectedVersion: 2, serverVersion: 9 });
    expect(result.current.draft?.text).toBe("我的本地草稿");
    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it("HTTP 409 抛 ConflictError 时同样保留本地草稿", async () => {
    const save = vi.fn(async () => {
      throw new ConflictError({ status: "conflict", version: 4 });
    });
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save,
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("本地未保存"));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.conflict?.serverVersion).toBe(4);
    expect(result.current.draft?.text).toBe("本地未保存");
  });

  it("冲突后可以用服务端最新版本号重新提交本地草稿", async () => {
    const save = vi.fn(async (input: { text: string; expectedVersion: number }): Promise<SaveResult> => {
      if (input.expectedVersion === 2) return { status: "conflict", version: 9 };
      return { status: "saved", version: 10 };
    });
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save,
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("重试的内容"));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).not.toBeNull();

    await act(async () => {
      await result.current.save(9);
    });

    expect(save).toHaveBeenLastCalledWith({ text: "重试的内容", expectedVersion: 9 });
    expect(result.current.conflict).toBeNull();
    expect(result.current.draft?.base?.version).toBe(10);
  });

  it("服务端推进版本时保留本地草稿，并以旧基线版本提交（不会静默覆盖）", async () => {
    const server = { ...outline };
    const save = vi.fn(async () => ({ status: "conflict", version: 6 }) as SaveResult);
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save,
          reload: async () => undefined,
        }),
      { initialProps: { current: server } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("本地草稿"));
    rerender({ current: { ...server, text: "服务端新内容", version: 6 } });

    // 有未保存修改：本地文本保留，基线仍是旧版本，快照更新为新版本。
    await waitFor(() => expect(result.current.serverAhead).toBe(true));
    expect(result.current.draft?.text).toBe("本地草稿");
    expect(result.current.draft?.base?.version).toBe(2);
    expect(result.current.draft?.server?.version).toBe(6);

    await act(async () => {
      await result.current.save();
    });
    expect(save).toHaveBeenCalledWith({ text: "本地草稿", expectedVersion: 2 });
    expect(result.current.conflict?.serverVersion).toBe(6);
    expect(result.current.draft?.text).toBe("本地草稿");
  });

  it("显式采用服务端内容会替换本地草稿（仅在用户操作时）", async () => {
    const server = { ...outline };
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save: async () => ({ status: "saved", version: 3 }),
          reload: async () => undefined,
        }),
      { initialProps: { current: server } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("本地草稿"));
    rerender({ current: { ...server, text: "服务端新内容", version: 6 } });

    await waitFor(() => expect(result.current.draft?.server?.version).toBe(6));
    expect(result.current.draft?.text).toBe("本地草稿");

    act(() => result.current.takeServer());
    expect(result.current.draft?.text).toBe("服务端新内容");
    expect(result.current.draft?.base?.version).toBe(6);
    expect(result.current.dirty).toBe(false);
  });

  it("服务端内容变化不会静默覆盖正在编辑的草稿（版本一致时）", async () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save: async () => ({ status: "saved", version: 3 }),
          reload: async () => undefined,
        }),
      { initialProps: { current: outline } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("编辑中"));
    rerender({ current: outline });
    expect(result.current.draft?.text).toBe("编辑中");
  });

  it("干净编辑器：模型工具写入后的服务端新文本被采纳为新的基线与显示文本", async () => {
    // 真实链路：持久 turn-end 触发业务 query 失效 → GET 返回 v4 的新文本 →
    // 这里（useDraft）在**没有未保存草稿**时采用它，编辑器显示服务器文本与新版本。
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save: async () => ({ status: "saved", version: 5 }),
          reload: async () => undefined,
        }),
      { initialProps: { current: outline } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.dirty).toBe(false);

    // 模型通过 update_outline 落库后的服务端读取结果。
    rerender({ current: { ...outline, text: "模型落库的新大纲", version: 4 } });

    await waitFor(() => expect(result.current.draft?.text).toBe("模型落库的新大纲"));
    expect(result.current.draft?.base?.version).toBe(4);
    expect(result.current.draft?.server?.version).toBe(4);
    expect(result.current.dirty).toBe(false);
    // 干净编辑器没有"远端已更新"的冲突提示：它已经采用了服务端内容。
    expect(result.current.serverAhead).toBe(false);
    expect(result.current.conflict).toBeNull();
  });

  it("有未保存草稿：远端更新时草稿原样保留，并提示服务端已推进（不强制覆盖）", async () => {
    const save = vi.fn(async (input: { text: string; expectedVersion: number }): Promise<SaveResult> =>
      input.expectedVersion === 2 ? { status: "conflict", version: 4 } : { status: "saved", version: 5 });
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save,
          reload: async () => undefined,
        }),
      { initialProps: { current: outline } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("用户正在写的草稿"));

    // 模型工具写入 → 服务端 v4；本地草稿必须原样保留。
    rerender({ current: { ...outline, text: "模型落库的新大纲", version: 4 } });

    await waitFor(() => expect(result.current.serverAhead).toBe(true));
    expect(result.current.draft?.text).toBe("用户正在写的草稿");
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft?.base?.version).toBe(2);
    expect(result.current.draft?.server?.version).toBe(4);

    // 保存提交的是**旧基线版本**：服务端因此返回 409 而不是静默覆盖远端更新。
    await act(async () => {
      await result.current.save();
    });
    expect(save).toHaveBeenCalledWith({ text: "用户正在写的草稿", expectedVersion: 2 });
    expect(result.current.conflict).toMatchObject({ expectedVersion: 2, serverVersion: 4 });
    expect(result.current.draft?.text).toBe("用户正在写的草稿");
  });

  it("编辑期间服务端出现新版本时，采用的是服务端快照供对比，但基线不动", async () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Outline }) =>
        useDraft<Outline>({
          identity: "outline:w1",
          server: current,
          save: async () => ({ status: "saved", version: 3 }),
          reload: async () => undefined,
        }),
      { initialProps: { current: outline } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("本地编辑"));
    rerender({ current: { ...outline, text: "别人的修改", version: 9 } });

    await waitFor(() => expect(result.current.serverAhead).toBe(true));
    expect(result.current.draft?.base?.version).toBe(2);
    expect(result.current.draft?.server?.text).toBe("别人的修改");
    expect(result.current.draft?.text).toBe("本地编辑");
    expect(result.current.conflict).toBeNull();
  });

  it("保存失败时给出错误且保留草稿", async () => {
    const save = vi.fn(async () => {
      throw new Error("无法连接 Myrix BFF");
    });
    const { result } = renderHook(() =>
      useDraft<Outline>({
        identity: "outline:w1",
        server: outline,
        save,
        reload: async () => undefined,
      }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("离线修改"));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.error).toBe("无法连接 Myrix BFF");
    expect(result.current.draft?.text).toBe("离线修改");
    expect(result.current.dirty).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const outlineA: Outline = { workId: "wA", text: "A 正文", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
const outlineB: Outline = { workId: "wB", text: "B 正文", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
const outlineV0: Outline = { workId: "w0", text: "v0 正文", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" };

describe("useDraft 代际隔离（切换对象后旧请求不得写当前 state）", () => {
  it("A→B：A 的保存晚到成功不污染 B 的正文/基线/版本/提示/saving", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    act(() => result.current.setText("A 的本地修改"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    await act(async () => {
      pending.resolve({ status: "saved", version: 5 });
      await savePromise;
    });

    // 返回值仍交给原 caller。
    expect(save).toHaveBeenCalledWith({ text: "A 的本地修改", expectedVersion: 1 });
    // 但 B 的状态完全没有被 A 的晚到结果触碰。
    expect(result.current.draft?.text).toBe("B 正文");
    expect(result.current.draft?.base?.version).toBe(1);
    expect(result.current.draft?.server?.version).toBe(1);
    expect(result.current.dirty).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("A→B：A 的保存晚到 409 不把冲突写到 B 上", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("A 的本地修改"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    let returned: SaveResult | null = null;
    await act(async () => {
      pending.resolve({ status: "conflict", version: 9 });
      returned = await savePromise;
    });

    expect(returned).toEqual({ status: "conflict", version: 9 });
    expect(result.current.conflict).toBeNull();
    expect(result.current.draft?.text).toBe("B 正文");
    expect(result.current.dirty).toBe(false);
  });

  it("A→B：A 的保存晚到异常不把错误写到 B 上", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("A 的本地修改"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    await act(async () => {
      pending.reject(new Error("A 的网络故障"));
      await savePromise;
    });

    expect(result.current.error).toBeNull();
    expect(result.current.draft?.text).toBe("B 正文");
  });

  it("A→B：A 的晚到 finally 不能清掉 B 正在进行的保存", async () => {
    const pendingA = deferred<SaveResult>();
    const pendingB = deferred<SaveResult>();
    const save = vi
      .fn<() => Promise<SaveResult>>()
      .mockImplementationOnce(() => pendingA.promise)
      .mockImplementationOnce(() => pendingB.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("A 的本地修改"));
    let saveA!: Promise<SaveResult | null>;
    act(() => {
      saveA = result.current.save();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    let saveB!: Promise<SaveResult | null>;
    act(() => {
      saveB = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    // A 的请求此时才结束：它的 finally 不能把 B 的 saving 置回 false。
    await act(async () => {
      pendingA.resolve({ status: "saved", version: 5 });
      await saveA;
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.draft?.text).toBe("B 正文");

    await act(async () => {
      pendingB.resolve({ status: "saved", version: 1 });
      await saveB;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.notice).toBe("已保存为版本 1");
  });

  it("A→B→A：切回原对象后旧代际的保存结果仍然被隔离（不只比较 ID）", async () => {
    const pendingOld = deferred<SaveResult>();
    const save = vi.fn<() => Promise<SaveResult>>(() => pendingOld.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("A 第一轮的本地修改"));
    let saveOld!: Promise<SaveResult | null>;
    act(() => {
      saveOld = result.current.save();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    await act(async () => {
      pendingOld.resolve({ status: "saved", version: 7 });
      await saveOld;
    });

    // 新一轮 A 必须保持干净，不能被上一代 A 的成功保存改写。
    expect(result.current.draft?.text).toBe("A 正文");
    expect(result.current.draft?.base?.version).toBe(1);
    expect(result.current.notice).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it("切换对象时清掉旧对象的 saving 与 error", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("A 的本地修改"));
    act(() => {
      void result.current.save();
    });
    expect(result.current.saving).toBe(true);

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("卸载后晚到的保存结果仍交给原 caller，但不再写状态", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() =>
      useDraft<Outline>({ identity: "outline:A", server: outlineA, save, reload: async () => undefined }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("卸载前的修改"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });

    unmount();
    pending.resolve({ status: "saved", version: 4 });
    await expect(savePromise).resolves.toEqual({ status: "saved", version: 4 });
  });

  it("切换对象后重读失败的晚到错误不写到新对象上", async () => {
    const pendingReload = deferred<unknown>();
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({
          identity,
          server,
          save: async () => ({ status: "saved", version: 1 }),
          reload: () => pendingReload.promise,
        }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = result.current.reloadServer();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    await act(async () => {
      pendingReload.reject(new Error("重读失败"));
      await reloadPromise;
    });

    expect(result.current.error).toBeNull();
  });
});

describe("useDraft 保存成功不丢保存后继续输入，也不回退已观测的更高版本", () => {
  it("未继续输入：正常 clean，并推进到服务端确认的版本", async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ status: "saved", version: 5 }));
    const { result } = renderHook(() =>
      useDraft<Outline>({ identity: "outline:w0", server: outlineV0, save, reload: async () => undefined }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("一次输入"));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.draft?.text).toBe("一次输入");
    expect(result.current.draft?.base?.version).toBe(5);
    expect(result.current.dirty).toBe(false);
    expect(result.current.notice).toBe("已保存为版本 5");
  });

  it("保存等待时继续输入：成功后保留后输入正文，基线只推进到提交快照，仍 dirty", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useDraft<Outline>({ identity: "outline:w0", server: outlineV0, save, reload: async () => undefined }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("提交时的内容"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });

    // 响应尚未返回，用户继续输入。
    act(() => result.current.setText("保存后继续输入的内容"));

    await act(async () => {
      pending.resolve({ status: "saved", version: 1 });
      await savePromise;
    });

    expect(save).toHaveBeenCalledWith({ text: "提交时的内容", expectedVersion: 0 });
    expect(result.current.draft?.text).toBe("保存后继续输入的内容");
    expect(result.current.draft?.base?.text).toBe("提交时的内容");
    expect(result.current.draft?.base?.version).toBe(1);
    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toBe("已保存为版本 1");
  });

  it("提交 v0→v1 未响应时已观测到 v2：晚到 v1 不回退版本（无新输入则采用 v2）", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ server }: { server: Outline }) =>
        useDraft<Outline>({ identity: "outline:w0", server, save, reload: async () => undefined }),
      { initialProps: { server: outlineV0 } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("提交时的内容"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });

    // 保存响应未回，但模型写入后 GET 已观测到 v2。
    rerender({ server: { ...outlineV0, text: "v2 模型正文", version: 2 } });
    await waitFor(() => expect(result.current.draft?.server?.version).toBe(2));

    await act(async () => {
      pending.resolve({ status: "saved", version: 1 });
      await savePromise;
    });

    // 绝不退回 v1：采用已经观测到的 v2。
    expect(result.current.draft?.base?.version).toBe(2);
    expect(result.current.draft?.server?.version).toBe(2);
    expect(result.current.draft?.text).toBe("v2 模型正文");
    expect(result.current.serverAhead).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("提交 v0→v1 未响应、已观测 v2 且用户继续输入：保留草稿并保留 CAS 保护（base=v1, server=v2）", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(async (input: { text: string; expectedVersion: number }): Promise<SaveResult> => {
      if (input.expectedVersion === 1) return { status: "conflict", version: 2 };
      return pending.promise;
    });
    const { result, rerender } = renderHook(
      ({ server }: { server: Outline }) =>
        useDraft<Outline>({ identity: "outline:w0", server, save, reload: async () => undefined }),
      { initialProps: { server: outlineV0 } },
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("提交时的内容"));
    let firstSave!: Promise<SaveResult | null>;
    act(() => {
      firstSave = result.current.save();
    });

    act(() => result.current.setText("保存后继续输入的内容"));
    rerender({ server: { ...outlineV0, text: "v2 模型正文", version: 2 } });
    await waitFor(() => expect(result.current.draft?.server?.version).toBe(2));

    await act(async () => {
      pending.resolve({ status: "saved", version: 1 });
      await firstSave;
    });

    expect(result.current.draft?.text).toBe("保存后继续输入的内容");
    expect(result.current.draft?.base?.text).toBe("提交时的内容");
    expect(result.current.draft?.base?.version).toBe(1);
    expect(result.current.draft?.server?.version).toBe(2);
    expect(result.current.serverAhead).toBe(true);
    expect(result.current.dirty).toBe(true);

    // 下一次保存仍以已提交基线 v1 提交 → 得到 409，而不是静默覆盖 v2。
    await act(async () => {
      await result.current.save();
    });
    expect(save).toHaveBeenLastCalledWith({ text: "保存后继续输入的内容", expectedVersion: 1 });
    expect(result.current.conflict).toMatchObject({ expectedVersion: 1, serverVersion: 2 });
    expect(result.current.draft?.text).toBe("保存后继续输入的内容");
  });

  it("409 与继续输入同时发生：冲突记录后输入的正文，本地草稿不丢", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn(() => pending.promise);
    const base: Outline = { ...outlineV0, version: 2, text: "初始正文" };
    const { result } = renderHook(() =>
      useDraft<Outline>({ identity: "outline:w0", server: base, save, reload: async () => undefined }),
    );

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setText("我的本地草稿"));
    let savePromise!: Promise<SaveResult | null>;
    act(() => {
      savePromise = result.current.save();
    });
    act(() => result.current.setText("继续输入"));

    await act(async () => {
      pending.resolve({ status: "conflict", version: 9 });
      await savePromise;
    });

    expect(result.current.conflict).toMatchObject({ expectedVersion: 2, serverVersion: 9 });
    expect(result.current.draft?.text).toBe("继续输入");
    expect(result.current.dirty).toBe(true);
  });
});

interface CommitFrame {
  identity: string;
  text: string | null;
  version: number | null;
  saving: boolean;
  error: string | null;
}

describe("useDraft 归属边界：第一帧、回调自持归属、提交期 ref", () => {
  it("切换 identity 的提交帧就已经是新对象（不等 passive effect 才归位）", async () => {
    const pending = deferred<SaveResult>();
    const save = vi.fn<() => Promise<SaveResult>>(() => pending.promise);
    const committed: CommitFrame[] = [];
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) => {
        const editor = useDraft<Outline>({ identity, server, save, reload: async () => undefined });
        // layout effect 在 commit 时运行，早于本 hook 的 passive effect：
        // 它看到的就是这一次 commit 真正交给界面的值。
        useLayoutEffect(() => {
          committed.push({
            identity,
            text: editor.draft?.text ?? null,
            version: editor.draft?.base?.version ?? null,
            saving: editor.saving,
            error: editor.error,
          });
        });
        return editor;
      },
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    act(() => result.current.setText("A 的本地修改"));
    let saveA!: Promise<SaveResult | null>;
    act(() => {
      saveA = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    committed.length = 0;
    rerender({ identity: "outline:B", server: outlineB });

    // 切到 B 的那一次 commit：正文/版本/saving/error 必须**已经**属于 B，
    // 不能出现“B 的第一帧仍返回 A 的 draft/saving/error”。
    const firstB = committed.find((frame) => frame.identity === "outline:B");
    expect(firstB).toMatchObject({ text: "B 正文", version: 1, saving: false, error: null });

    await act(async () => {
      pending.resolve({ status: "saved", version: 5 });
      await saveA;
    });
    expect(result.current.draft?.text).toBe("B 正文");
  });

  it("A→B→A 后旧 A 的 save 回调被延迟调用：不读新 owner、不把当前正文发往旧目标", async () => {
    const calls: { text: string; expectedVersion: number }[] = [];
    const save = vi.fn(async (input: { text: string; expectedVersion: number }): Promise<SaveResult> => {
      calls.push(input);
      return { status: "saved", version: 1 };
    });
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    // 保留第一轮 A 的 save 回调，稍后（A→B→A 之后）才调用。
    const staleSave = result.current.save;

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    act(() => result.current.setText("B 的本地修改"));

    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    act(() => result.current.setText("A 第二轮的本地修改"));

    // 旧 A 回调直到现在才被调用：它属于已废弃的代际，必须拒绝，而不是
    // “在调用时偷取”当前 owner 后把“A 第二轮的本地修改”发往 save。
    let returned: SaveResult | null = null;
    await act(async () => {
      returned = await staleSave();
    });

    expect(returned).toBeNull();
    expect(calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(result.current.draft?.text).toBe("A 第二轮的本地修改");
    expect(result.current.draft?.base?.version).toBe(1);
    expect(result.current.notice).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it("A→B→A 后旧 A 的 setText 不得改写新一轮 A", async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ status: "saved", version: 2 }));
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    const staleSetText = result.current.setText;

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    act(() => staleSetText("旧回调注入的正文"));

    // 旧代际的 setText 必须被拒绝：新一轮 A 仍是干净的服务端基线。
    expect(result.current.draft?.text).toBe("A 正文");
    expect(result.current.dirty).toBe(false);
  });

  it("A→B→A 后旧 A 的 takeServer 不得丢弃新一轮 A 的本地草稿", async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ status: "saved", version: 2 }));
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    const staleTakeServer = result.current.takeServer;

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    act(() => result.current.setText("A 第二轮的本地修改"));
    act(() => staleTakeServer());

    // 旧回调不得把新一轮 A 的草稿替换成服务端内容。
    expect(result.current.draft?.text).toBe("A 第二轮的本地修改");
    expect(result.current.dirty).toBe(true);
  });

  it("A→B→A 后旧 A 的 dismissNotice/clearError 不得清掉新一轮 A 的提示与错误", async () => {
    let mode: "saved" | "failed" = "saved";
    const save = vi.fn(async (): Promise<SaveResult> => {
      if (mode === "failed") throw new Error("新一轮 A 的网络故障");
      return { status: "saved", version: 2 };
    });
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    const staleDismissNotice = result.current.dismissNotice;
    const staleClearError = result.current.clearError;

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    // 新一轮 A 上制造提示。
    act(() => result.current.setText("A 第二轮的本地修改"));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.notice).toBe("已保存为版本 2");

    act(() => staleDismissNotice());
    expect(result.current.notice).toBe("已保存为版本 2");

    // 再在新一轮 A 上制造错误。
    mode = "failed";
    act(() => result.current.setText("A 第二轮的再次修改"));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).toBe("新一轮 A 的网络故障");

    act(() => staleClearError());
    expect(result.current.error).toBe("新一轮 A 的网络故障");
  });

  it("A→B→A 后旧 A 的 reloadServer 被延迟调用：不向旧目标发起重读", async () => {
    const reload = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({
          identity,
          server,
          save: async () => ({ status: "saved", version: 1 }),
          reload,
        }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    const staleReload = result.current.reloadServer;

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    await act(async () => {
      await staleReload();
    });

    // 旧回调属于已废弃的代际：绝不能把重读请求发往旧目标。
    expect(reload).not.toHaveBeenCalled();
  });

  it("切换 identity 的 commit 窗口内启动的保存已归属新对象：旧 finally 与旧重置都不清它的 saving", async () => {
    const pendingA = deferred<SaveResult>();
    const pendingB = deferred<SaveResult>();
    const save = vi
      .fn<() => Promise<SaveResult>>()
      .mockImplementationOnce(() => pendingA.promise)
      .mockImplementationOnce(() => pendingB.promise);
    // 在切到 B 的那一次 commit 的 layout 阶段启动 B 的保存：这早于旧实现
    // 用 passive effect 归位归属，因此能暴露“归属在 passive 才更新”的窗口。
    let startBOnCommit = false;
    let bSave: Promise<SaveResult | null> | null = null;

    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) => {
        const editor = useDraft<Outline>({ identity, server, save, reload: async () => undefined });
        useLayoutEffect(() => {
          if (startBOnCommit) {
            startBOnCommit = false;
            bSave = editor.save();
          }
        });
        return editor;
      },
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    act(() => result.current.setText("A 第一轮"));
    let firstA!: Promise<SaveResult | null>;
    act(() => {
      firstA = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    startBOnCommit = true;
    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    // B 的保存在 B 的 commit 里就属于 B：不能被切换时的清理或 A 的 finally 清掉。
    expect(result.current.saving).toBe(true);

    await act(async () => {
      pendingA.resolve({ status: "saved", version: 5 });
      await firstA;
    });
    expect(result.current.saving).toBe(true);

    await act(async () => {
      pendingB.resolve({ status: "saved", version: 2 });
      await bSave;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.draft?.base?.version).toBe(2);
    expect(result.current.notice).toBe("已保存为版本 2");
  });

  it("A→B→A：第一轮 A 的晚到 finally 不清第二轮 A 的 saving（saving 计数按 owner 归属）", async () => {
    const pendingFirst = deferred<SaveResult>();
    const pendingSecond = deferred<SaveResult>();
    const save = vi
      .fn<() => Promise<SaveResult>>()
      .mockImplementationOnce(() => pendingFirst.promise)
      .mockImplementationOnce(() => pendingSecond.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    act(() => result.current.setText("A 第一轮"));
    let firstA!: Promise<SaveResult | null>;
    act(() => {
      firstA = result.current.save();
    });

    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));
    rerender({ identity: "outline:A", server: outlineA });
    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));

    act(() => result.current.setText("A 第二轮"));
    let secondA!: Promise<SaveResult | null>;
    act(() => {
      secondA = result.current.save();
    });
    expect(result.current.saving).toBe(true);

    // 第一轮 A 的请求此时才结束：它的 finally 不得清掉第二轮 A 的 saving。
    await act(async () => {
      pendingFirst.resolve({ status: "saved", version: 5 });
      await firstA;
    });
    expect(result.current.saving).toBe(true);
    expect(result.current.draft?.text).toBe("A 第二轮");
    expect(result.current.notice).toBeNull();

    await act(async () => {
      pendingSecond.resolve({ status: "saved", version: 3 });
      await secondA;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.draft?.base?.version).toBe(3);
    expect(result.current.notice).toBe("已保存为版本 3");
  });

  it("受控 Suspense：被并发丢弃的 render 不污染已提交 draftRef，save 不发出被丢弃的正文", async () => {
    const calls: { text: string; expectedVersion: number }[] = [];
    const save = vi.fn(async (input: { text: string; expectedVersion: number }): Promise<SaveResult> => {
      calls.push(input);
      return { status: "saved", version: 1 };
    });
    const gate = deferred<never>();
    const committedRef: { current: DraftEditor<Outline> | null } = { current: null };

    function Probe({ server, suspend }: { server: Outline; suspend: boolean }) {
      const editor = useDraft<Outline>({ identity: "outline:A", server, save, reload: async () => undefined });
      useLayoutEffect(() => {
        if (!suspend) committedRef.current = editor;
      });
      // 受控挂起：只在显式开启时抛出，且 promise 永不 resolve，
      // 因此这次并发渲染一定会被丢弃，而不是被重试提交。
      if (suspend) throw gate.promise;
      return null;
    }

    const view = (props: { server: Outline; suspend: boolean }) => (
      <Suspense fallback={<span>loading</span>}>
        <Probe {...props} />
      </Suspense>
    );

    const { rerender } = render(view({ server: outlineA, suspend: false }));
    await waitFor(() => expect(committedRef.current?.draft?.text).toBe("A 正文"));

    // 一次并发（可被打断的）渲染里同时：写入新正文 + 挂起。
    // React 会丢弃这次 render，但它已经执行了 useDraft 的函数体。
    act(() => {
      startTransition(() => {
        committedRef.current?.setText("被丢弃的正文");
        rerender(view({ server: outlineA, suspend: true }));
      });
    });

    // 已提交的界面仍是挂起前的正文。
    expect(committedRef.current?.draft?.text).toBe("A 正文");

    // 此刻保存：只能提交**已提交**的正文，绝不能发出被丢弃 render 里的文本。
    await act(async () => {
      await committedRef.current?.save();
    });
    expect(calls).toEqual([{ text: "A 正文", expectedVersion: 1 }]);
    expect(committedRef.current?.draft?.text).toBe("A 正文");
  });

  it("StrictMode 双调用下切换归属与保存都不重复：一次 save 只发一次请求", async () => {
    // 本文件已 `configure({ reactStrictMode: true })`：React 会双调用 render 与
    // effect。归属重建必须幂等，一次 save 只能产生一次服务端调用。
    const pending = deferred<SaveResult>();
    const save = vi.fn<() => Promise<SaveResult>>(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ identity, server }: { identity: string; server: Outline }) =>
        useDraft<Outline>({ identity, server, save, reload: async () => undefined }),
      { initialProps: { identity: "outline:A", server: outlineA } },
    );

    await waitFor(() => expect(result.current.draft?.text).toBe("A 正文"));
    rerender({ identity: "outline:B", server: outlineB });
    await waitFor(() => expect(result.current.draft?.text).toBe("B 正文"));

    act(() => result.current.setText("B 的本地修改"));
    let saveB!: Promise<SaveResult | null>;
    act(() => {
      saveB = result.current.save();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ text: "B 的本地修改", expectedVersion: 1 });

    await act(async () => {
      pending.resolve({ status: "saved", version: 3 });
      await saveB;
    });
    expect(result.current.draft?.base?.version).toBe(3);
    expect(result.current.notice).toBe("已保存为版本 3");
    expect(result.current.saving).toBe(false);
  });
});
