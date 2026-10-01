import type { Chapter, NovelSession, Outline, Work } from "@myrix/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工作台**选择归属**的真实组件测试。
 *
 * 只替换网络 / EventSource / 认证边界（`endpoints`、`http.openEventSource`、`useAuth`）
 * 与 Tiptap 编辑器（jsdom 里没有排版引擎，且这里断言的是选择状态而非排版）。
 * App 的 `Selection` 归约、新建/切换/撤销回包的代际判定、按 workId 的组件 key
 * 全部是真实实现——绝不用替身替换这些关键逻辑。
 */

const mocks = vi.hoisted(() => ({
  worksList: vi.fn(),
  worksCreate: vi.fn(),
  worksRemove: vi.fn(),
  outlineGet: vi.fn(),
  outlineSave: vi.fn(),
  chaptersList: vi.fn(),
  chaptersCreate: vi.fn(),
  chaptersGet: vi.fn(),
  chaptersVersions: vi.fn(),
  chaptersSave: vi.fn(),
  bibleList: vi.fn(),
  bibleCreate: vi.fn(),
  bibleSave: vi.fn(),
  sessionsList: vi.fn(),
  sessionsCreate: vi.fn(),
  sessionsRemove: vi.fn(),
  sessionsSend: vi.fn(),
  sessionsCancel: vi.fn(),
  openEventSource: vi.fn(),
}));

// 认证是外部边界：这里只声明“已登录”，工作台内部逻辑保持真实。
vi.mock("../src/state/useAuth", () => ({
  useAuth: () => ({
    config: { mode: "development", loginUrl: "/auth/login" },
    session: {
      identity: { tenantId: "t1", userId: "u1", displayName: "作者", role: "member" },
      csrfToken: "csrf",
      mode: "development",
    },
    isLoading: false,
    isAuthenticated: true,
    sessionError: null,
    loginWithOidc: vi.fn(),
    devLogin: vi.fn(),
    devLoginPending: false,
    devLoginError: null,
    logout: vi.fn(),
    logoutPending: false,
  }),
}));

// Tiptap 的 DOM 机制不是本测试的对象；选择逻辑仍在真实的 OutlinePanel/ChapterPanel 之上。
vi.mock("../src/components/PlainTextEditor", () => ({
  PlainTextEditor: ({ value, ariaLabel }: { value: string; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} readOnly value={value} />
  ),
}));

vi.mock("../src/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/endpoints")>();
  return {
    ...actual,
    works: {
      ...actual.works,
      list: mocks.worksList,
      create: mocks.worksCreate,
      remove: mocks.worksRemove,
      outline: { ...actual.works.outline, get: mocks.outlineGet, save: mocks.outlineSave },
      chapters: {
        ...actual.works.chapters,
        list: mocks.chaptersList,
        create: mocks.chaptersCreate,
        get: mocks.chaptersGet,
        versions: mocks.chaptersVersions,
        save: mocks.chaptersSave,
      },
      bible: {
        ...actual.works.bible,
        list: mocks.bibleList,
        create: mocks.bibleCreate,
        save: mocks.bibleSave,
      },
    },
    sessions: {
      ...actual.sessions,
      list: mocks.sessionsList,
      create: mocks.sessionsCreate,
      remove: mocks.sessionsRemove,
      send: mocks.sessionsSend,
      cancel: mocks.sessionsCancel,
    },
  };
});

vi.mock("../src/api/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/http")>();
  return { ...actual, openEventSource: mocks.openEventSource };
});

import { App } from "../src/App";

/** 受控 EventSource 替身：测试自己决定何时 open/message/error（这里只需要形状）。 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ISO = "2026-01-01T00:00:00.000Z";

function work(id: string, title: string): Work {
  return {
    id,
    tenantId: "t1",
    ownerUserId: "u1",
    title,
    description: "",
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function session(id: string, workId: string, preset: NovelSession["preset"]): NovelSession {
  return { id, workId, preset, status: "active", createdAt: ISO };
}

function chapter(id: string, workId: string, title: string): Chapter {
  return { id, workId, title, text: "正文", version: 1, updatedAt: ISO };
}

const W1 = work("w1", "作品一");
const W2 = work("w2", "作品二");
const S1 = session("s1", "w1", "novel-chapter");
const S2 = session("s2", "w1", "novel-outline");

let workItems: Work[];
let sessionItems: Record<string, NovelSession[]>;

function renderApp(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function assistantRegion(): HTMLElement {
  return screen.getByRole("region", { name: "创作助手" });
}

/** 会话列表里的条目：带 preset 标题与“活跃”状态，区别于 preset 选项与新建按钮。 */
function sessionButton(presetTitle: string): HTMLElement {
  return within(assistantRegion()).getByRole("button", {
    name: new RegExp(`${presetTitle}[\\s\\S]*活跃`),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];

  workItems = [W1, W2];
  sessionItems = { w1: [S1, S2] };

  mocks.worksList.mockImplementation(async () => ({ items: workItems }));
  mocks.worksCreate.mockImplementation(async (input: { title: string }) => work("w-new", input.title));
  mocks.worksRemove.mockResolvedValue(null);

  mocks.outlineGet.mockImplementation(async (workId: string): Promise<Outline> => ({
    workId,
    text: "大纲",
    version: 1,
    updatedAt: ISO,
  }));
  mocks.outlineSave.mockResolvedValue({ status: "saved", version: 2 });

  mocks.chaptersList.mockImplementation(async () => ({ items: [] }));
  mocks.chaptersCreate.mockImplementation(async (workId: string, input: { title: string }) =>
    chapter("c-new", workId, input.title),
  );
  mocks.chaptersGet.mockImplementation(async (workId: string, chapterId: string) =>
    chapter(chapterId, workId, "迟到的章节"),
  );
  mocks.chaptersVersions.mockResolvedValue({ items: [] });
  mocks.chaptersSave.mockResolvedValue({ status: "saved", version: 2 });

  mocks.bibleList.mockResolvedValue({ items: [] });
  mocks.bibleCreate.mockResolvedValue({
    id: "b-new",
    workId: "w1",
    kind: "character",
    title: "新条目",
    text: "",
    version: 1,
    updatedAt: ISO,
  });
  mocks.bibleSave.mockResolvedValue({ status: "saved", version: 2 });

  mocks.sessionsList.mockImplementation(async (workId: string) => ({
    items: sessionItems[workId] ?? [],
  }));
  mocks.sessionsCreate.mockImplementation(async (workId: string, preset: NovelSession["preset"]) =>
    session("s-new", workId, preset),
  );
  mocks.sessionsRemove.mockResolvedValue(null);
  mocks.sessionsSend.mockResolvedValue({ commandId: "c-1", status: "queued" });
  mocks.sessionsCancel.mockResolvedValue({ commandId: "c-1", status: "queued" });

  mocks.openEventSource.mockImplementation((path: string) => new FakeEventSource(path) as unknown as EventSource);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

describe("App 选择归属", () => {
  it("新建作品成功会清空旧作品的会话，不把旧 session 留在新作品界面", async () => {
    workItems = [W1]; // 新作品尚不存在
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));
    await user.click(await screen.findByRole("button", { name: /章节写作[\s\S]*活跃/ }));
    expect(sessionButton("章节写作")).toHaveAttribute("aria-current", "true");

    const created = W2;
    const gate = deferred<Work>();
    mocks.worksCreate.mockReturnValueOnce(gate.promise);

    await user.type(screen.getByLabelText("标题"), "作品二");
    await user.click(screen.getByRole("button", { name: "创建作品" }));

    await act(async () => {
      workItems = [...workItems, created];
      gate.resolve(created);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /作品二/ })).toHaveAttribute("aria-current", "true"),
    );
    // 关键回归：新作品里没有任何选中的会话，输入框回到“先选择或新建会话”，
    // 而不是沿用旧作品的 s1 继续发送模型命令。
    expect(screen.getByPlaceholderText("先选择或新建会话")).toBeDefined();
    expect(mocks.sessionsSend).not.toHaveBeenCalled();
  });

  it("创建会话期间切到另一个作品：迟到的 create 回包不会自动选中", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));
    const gate = deferred<NovelSession>();
    mocks.sessionsCreate.mockReturnValueOnce(gate.promise);

    await user.click(screen.getByRole("button", { name: /新建会话/ }));
    await user.click(screen.getByRole("button", { name: /作品二/ }));

    await act(async () => {
      gate.resolve(session("s-late", "w1", "novel-chapter"));
    });

    expect(screen.getByPlaceholderText("先选择或新建会话")).toBeDefined();
  });

  it("A→B→A：创建会话的旧回包不得偷选回到 A 后的选择", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));
    const gate = deferred<NovelSession>();
    mocks.sessionsCreate.mockReturnValueOnce(gate.promise);

    await user.click(screen.getByRole("button", { name: /新建会话/ }));
    await user.click(screen.getByRole("button", { name: /作品二/ }));
    await user.click(screen.getByRole("button", { name: /作品一/ }));

    await act(async () => {
      gate.resolve(session("s-late", "w1", "novel-chapter"));
    });

    // 当前 work 虽然又等于发起时的 w1，但代际已经被两次显式选择推进：
    // 旧回包属于上一条选择，必须丢弃。
    expect(screen.getByPlaceholderText("先选择或新建会话")).toBeDefined();
  });

  it("旧会话撤销回包不能清空后来选中的会话", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));
    await user.click(await screen.findByRole("button", { name: /章节写作[\s\S]*活跃/ }));

    const gate = deferred<null>();
    mocks.sessionsRemove.mockReturnValueOnce(gate.promise);
    await user.click(screen.getByRole("button", { name: "撤销会话" }));

    await user.click(sessionButton("大纲助手"));
    expect(sessionButton("大纲助手")).toHaveAttribute("aria-current", "true");

    await act(async () => {
      gate.resolve(null);
    });

    // 撤销的是 s1；用户后来选了 s2，迟到的回包不得把 s2 的选择清掉。
    expect(sessionButton("大纲助手")).toHaveAttribute("aria-current", "true");
    expect(sessionButton("章节写作")).toHaveAttribute("aria-current", "false");
  });

  it("旧删除作品回包不能清空用户后来选中的作品", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));

    const gate = deferred<null>();
    mocks.worksRemove.mockReturnValueOnce(gate.promise);
    await user.click(screen.getByRole("button", { name: "删除当前作品" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await user.click(screen.getByRole("button", { name: /作品二/ }));
    expect(screen.getByRole("button", { name: /作品二/ })).toHaveAttribute("aria-current", "true");

    await act(async () => {
      workItems = workItems.filter((item) => item.id !== W1.id);
      gate.resolve(null);
    });

    // 删除的是 w1；用户已经选了 w2，迟到的回包不得把 w2 清成 null。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /作品二/ })).toHaveAttribute("aria-current", "true"),
    );
  });

  it("中栏按 work 隔离：新建章节的迟到回包不会在新作品里选中章节", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /作品一/ }));
    await user.click(screen.getByRole("tab", { name: "章节" }));

    const gate = deferred<Chapter>();
    mocks.chaptersCreate.mockReturnValueOnce(gate.promise);
    await user.type(screen.getByLabelText("新章节标题"), "迟到章节");
    await user.click(screen.getByRole("button", { name: "新建章节" }));

    // 切到另一个作品：WorkspacePane 以 workId 为 key 重建，本地章节选择属于 w1 实例。
    await user.click(screen.getByRole("button", { name: /作品二/ }));
    await user.click(screen.getByRole("tab", { name: "章节" }));

    await act(async () => {
      gate.resolve(chapter("c-late", "w1", "迟到的章节"));
    });

    // w2 的中栏没有选中任何章节：既不会显示 w1 的迟到章节，也不会去读取它。
    expect(screen.getByText("请选择或新建一个章节。")).toBeDefined();
    expect(screen.queryByText(/迟到的章节/)).toBeNull();
    expect(mocks.chaptersGet).not.toHaveBeenCalled();
  });
});
