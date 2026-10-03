import type { Chapter, NovelSession, Outline, Work } from "@myrix/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工作台**选择归属**的端到端组件测试：登录 → 书架 → 开书（首章自动选中）→
 * 返回书架 → 切换作品，以及"代际晚到的回包绝不抢走/清空用户的新选择"。
 *
 * 只替换网络 / EventSource / 认证边界（`endpoints`、`http.openEventSource`、`useAuth`）
 * 与 Tiptap 编辑器（jsdom 没有排版引擎，这里断言的是选择状态而不是排版）。
 * App 的 Selection 归约、按 workId 的组件 key、WorkspacePane 的首开建议、
 * AssistantPanel 的首条消息等待全部是真实实现——绝不用替身替换这些关键逻辑。
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
  sessionsArchive: vi.fn(),
  sessionsSend: vi.fn(),
  sessionsCancel: vi.fn(),
  openEventSource: vi.fn(),
}));

/** 认证是外部边界：这里可以显式在“未登录/已登录”之间切换，工作台内部逻辑保持真实。 */
const authMock = vi.hoisted(() => ({
  state: {
    config: { mode: "development", loginUrl: "/auth/login" },
    session: {
      identity: { tenantId: "t1", userId: "u1", displayName: "作者", role: "member" },
      csrfToken: "csrf",
      mode: "development",
    },
    isLoading: false,
    isAuthenticated: true,
    sessionError: null as string | null,
    loginWithOidc: vi.fn(),
    devLogin: vi.fn(),
    devLoginPending: false,
    devLoginError: null as string | null,
    logout: vi.fn(),
    logoutPending: false,
  },
}));

vi.mock("../src/state/useAuth", () => ({ useAuth: () => authMock.state }));

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
      archive: mocks.sessionsArchive,
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

/** 受控 EventSource 替身：测试自己决定何时 open/message/error。 */
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
const ISO2 = "2026-02-02T00:00:00.000Z";

function work(id: string, title: string): Work {
  return { id, tenantId: "t1", ownerUserId: "u1", title, description: "", createdAt: ISO, updatedAt: ISO };
}

function session(id: string, workId: string, overrides: Partial<NovelSession> = {}): NovelSession {
  return { id, workId, preset: "novel-assistant", status: "active", createdAt: ISO, ...overrides };
}

function chapter(id: string, workId: string, title: string): Chapter {
  return { id, workId, title, text: "正文", version: 1, updatedAt: ISO };
}

const W1 = work("w1", "作品一");
const W2 = work("w2", "作品二");
const W3 = work("w3", "新书");
const C1 = chapter("c1", "w1", "第一章");
const C2 = chapter("c2", "w2", "乙章");
const S1 = session("s1", "w1");
const S2 = session("s2", "w1");

let workItems: Work[];
let sessionItems: Record<string, NovelSession[]>;
let chapterItems: Record<string, Chapter[]>;
let chapterById: Record<string, Chapter>;

function appTree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  return { client, ...render(appTree(client)) };
}

function assistant(): HTMLElement {
  return screen.getByRole("region", { name: "创作助手" });
}

/**
 * 文稿阅读/编辑两种模式的 aria-label：阅读态是 `${label}阅读`，编辑态是 `label`。
 * 用前缀匹配两者，避免测试为了找“正文在不在”而假设某一种模式。
 */
function manuscriptPattern(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

function findManuscript(label: string): Promise<HTMLElement> {
  return screen.findByLabelText(manuscriptPattern(label));
}

function queryManuscript(label: string): HTMLElement | null {
  return screen.queryByLabelText(manuscriptPattern(label));
}

/** 历史列表里的会话条目（统一 Agent 显示为“创作 Agent · 序号”）。 */
function historyItem(index: number): HTMLElement {
  return within(assistant()).getByRole("button", { name: new RegExp(`创作 Agent · ${index}`) });
}

/** 会话列表是异步读取的：点条目之前先等它出现。 */
function findHistoryItem(index: number): Promise<HTMLElement> {
  return within(assistant()).findByRole("button", { name: new RegExp(`创作 Agent · ${index}`) });
}

async function expectShelf(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("heading", { name: /我的书架/ })).toBeDefined());
  expect(screen.queryByRole("region", { name: "作品内容" })).toBeNull();
}

async function openBook(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(await screen.findByLabelText(`打开书本：${title}`));
  await waitFor(() => expect(screen.getByRole("region", { name: "作品内容" })).toBeDefined());
}

async function backToShelf(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "书架" }));
  await expectShelf();
}

async function openHistory(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  if (within(assistant()).queryByText("对话记录")) return;
  await user.click(screen.getByRole("button", { name: "历史对话" }));
  expect(within(assistant()).getByText("对话记录")).toBeDefined();
}

/** 选中会话的可靠标志：只有选中了会话才出现“当前对话操作”。 */
async function expectSessionSelected(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText("当前对话操作")).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  authMock.state.isAuthenticated = true;
  authMock.state.sessionError = null;
  // 默认确认所有“离开会丢草稿”的询问；需要拒绝的用例再局部覆盖。
  vi.stubGlobal("confirm", vi.fn(() => true));

  workItems = [W1, W2];
  sessionItems = { w1: [S1, S2], w2: [] };
  chapterItems = { w1: [C1], w2: [C2] };
  chapterById = { c1: C1, c2: C2 };

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

  mocks.chaptersList.mockImplementation(async (workId: string) => ({ items: chapterItems[workId] ?? [] }));
  mocks.chaptersCreate.mockImplementation(async (workId: string, input: { title: string }) => {
    const created = chapter(`c-new-${input.title}`, workId, input.title);
    chapterById[created.id] = created;
    return created;
  });
  mocks.chaptersGet.mockImplementation(async (workId: string, chapterId: string) =>
    chapterById[chapterId] ?? chapter(chapterId, workId, "章节"),
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

  mocks.sessionsList.mockImplementation(async (workId: string) => ({ items: sessionItems[workId] ?? [] }));
  mocks.sessionsCreate.mockImplementation(async (workId: string) => session("s-new", workId));
  mocks.sessionsRemove.mockResolvedValue(null);
  mocks.sessionsArchive.mockImplementation(async (sessionId: string, archived: boolean) => {
    const found = Object.values(sessionItems).flat().find((item) => item.id === sessionId);
    return { ...(found ?? session(sessionId, "w1")), archivedAt: archived ? ISO2 : null };
  });
  mocks.sessionsSend.mockResolvedValue({ commandId: "cmd-1", status: "queued" });
  mocks.sessionsCancel.mockResolvedValue({ commandId: "cmd-1", status: "queued" });

  mocks.openEventSource.mockImplementation((path: string) => new FakeEventSource(path) as unknown as EventSource);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

describe("App 登录 → 书架 → 开书 → 返回书架 → 切书", () => {
  it("未登录显示登录入口；登录后落到书架而不是直接进书", async () => {
    authMock.state.isAuthenticated = false;
    const view = renderApp();
    expect(screen.getByRole("region", { name: "登录" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: /我的书架/ })).toBeNull();

    authMock.state.isAuthenticated = true;
    view.rerender(appTree(view.client));

    await expectShelf();
    expect(await screen.findByLabelText("打开书本：作品一")).toBeDefined();
    expect(screen.getByLabelText("打开书本：作品二")).toBeDefined();
  });

  it("开书自动选中第一章；返回书架再开另一本，切换为那本书自己的内容", async () => {
    const user = userEvent.setup();
    renderApp();
    await expectShelf();

    // 开第一本：有章节 → 首开建议选中第一项，中栏直接显示正文。
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");
    expect(screen.getByRole("button", { name: "章节" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("navigation", { name: "书内目录" })).getByRole("button", { name: /第一章/ })).toHaveAttribute("aria-current", "true");

    // 目录新建按需展开：已有章节时先收起，点“新建章节”才展开表单，收起后回到折叠态。
    expect(screen.queryByLabelText("新章节标题")).toBeNull();
    await user.click(screen.getByRole("button", { name: "新建章节" }));
    expect(screen.getByLabelText("新章节标题")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByLabelText("新章节标题")).toBeNull();

    // 选一条会话，验证返回书架后不会留在别的书里。
    await openHistory(user);
    await user.click(await findHistoryItem(1));
    await expectSessionSelected();

    await backToShelf(user);

    // 开第二本：显示的是它自己的章，不是上一本的。
    await openBook(user, "作品二");
    await findManuscript("章节正文：乙章");
    expect(queryManuscript("章节正文：第一章")).toBeNull();

    // 会话选择按作品隔离：作品二还没有任何会话。
    await openHistory(user);
    await waitFor(() => expect(within(assistant()).getByText("还没有对话，从下面的一句话开始。")).toBeDefined());
    expect(mocks.sessionsSend).not.toHaveBeenCalled();
  });

  it("没有章节的书留在大纲，不伪造选中", async () => {
    const user = userEvent.setup();
    chapterItems = { w1: [C1], w2: [] };
    renderApp();
    await expectShelf();

    await openBook(user, "作品二");
    await findManuscript("作品大纲");
    expect(screen.getByRole("button", { name: "大纲" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "章节" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("App 代际归属：迟到的异步回包不抢用户的新选择", () => {
  it("创建作品期间开了别的书：迟到的创建回包不切走当前书，但新书仍进入书架", async () => {
    const user = userEvent.setup();
    renderApp();
    await expectShelf();

    const gate = deferred<Work>();
    mocks.worksCreate.mockReturnValueOnce(gate.promise);

    await user.click(screen.getByRole("button", { name: /新建书本/ }));
    await user.type(screen.getByLabelText("书名"), "新书");
    await user.click(screen.getByRole("button", { name: "创建并开始写作" }));

    // 创建在途时用户先开了作品一。
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    workItems = [...workItems, W3];
    await act(async () => {
      gate.resolve(W3);
    });

    // 迟到的回包属于上一条选择：不抢走当前的书。
    expect(queryManuscript("章节正文：第一章")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: /我的书架/ })).toBeNull();

    // 但它仍然落进书架列表（结果不被丢弃，只是不抢选择）。
    await backToShelf(user);
    expect(screen.getByLabelText("打开书本：新书")).toBeDefined();
  });

  it("新建会话（首条消息）期间切书：迟到的会话不选中，也不把首条消息发出去", async () => {
    const user = userEvent.setup();
    sessionItems = { w1: [], w2: [] };
    renderApp();
    await expectShelf();

    const gate = deferred<NovelSession>();
    mocks.sessionsCreate.mockReturnValueOnce(gate.promise);

    await openBook(user, "作品二");
    await findManuscript("章节正文：乙章");
    await user.type(screen.getByLabelText("消息输入"), "写个开头");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.sessionsCreate).toHaveBeenCalledWith("w2", "novel-assistant"));

    // 创建在途时切回作品一。
    await backToShelf(user);
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await act(async () => {
      gate.resolve(session("s-late", "w2"));
    });

    await waitFor(() => expect(mocks.sessionsSend).not.toHaveBeenCalled());
    await openHistory(user);
    await waitFor(() => expect(within(assistant()).getByText("还没有对话，从下面的一句话开始。")).toBeDefined());
  });

  it("A→B→A：新建会话的旧回包不得偷选回到 A 之后的选择", async () => {
    const user = userEvent.setup();
    sessionItems = { w1: [], w2: [] };
    renderApp();
    await expectShelf();

    const gate = deferred<NovelSession>();
    mocks.sessionsCreate.mockReturnValueOnce(gate.promise);

    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");
    await user.type(screen.getByLabelText("消息输入"), "第一条");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.sessionsCreate).toHaveBeenCalledWith("w1", "novel-assistant"));

    await backToShelf(user);
    await openBook(user, "作品二");
    await findManuscript("章节正文：乙章");
    await backToShelf(user);
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await act(async () => {
      gate.resolve(session("s-late", "w1"));
    });

    // workId 虽然又等于发起时的 w1，但代际已被两次显式选择推进：旧回包必须丢弃。
    expect(mocks.sessionsSend).not.toHaveBeenCalled();
    await openHistory(user);
    await waitFor(() => expect(within(assistant()).getByText("还没有对话，从下面的一句话开始。")).toBeDefined());
  });

  it("归档会话期间用户改选另一条：迟到的归档不清空新选择，归档结果仍然生效", async () => {
    const user = userEvent.setup();
    renderApp();
    await expectShelf();

    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await openHistory(user);
    await user.click(await findHistoryItem(1));
    await expectSessionSelected();

    const gate = deferred<NovelSession>();
    mocks.sessionsArchive.mockReturnValueOnce(gate.promise);
    await user.click(screen.getByLabelText("当前对话操作"));
    await user.click(screen.getByRole("button", { name: "归档对话" }));
    await waitFor(() => expect(mocks.sessionsArchive).toHaveBeenCalledWith("s1", true));

    // 归档在途时用户改选第二条会话。
    await openHistory(user);
    await user.click(await findHistoryItem(2));
    await expectSessionSelected();

    sessionItems = { ...sessionItems, w1: [{ ...S1, archivedAt: ISO2 }, S2] };
    await act(async () => {
      gate.resolve({ ...S1, archivedAt: ISO2 });
    });

    // 迟到回包归档的是 s1；当前选择是 s2，不得被清空（最近里只剩 s2，即第 1 项）。
    await openHistory(user);
    await waitFor(() => expect(historyItem(1)).toHaveAttribute("aria-current", "true"));
    expect(within(assistant()).queryByRole("button", { name: /创作 Agent · 2/ })).toBeNull();

    // 归档本身仍然落定：切到“已归档”能看到 s1，并且可恢复。
    await user.click(screen.getByRole("button", { name: "已归档" }));
    const archivedItem = within(assistant()).getByRole("button", { name: /创作 Agent · 1/ });
    expect(archivedItem).toBeDefined();
    expect(within(assistant()).getByLabelText("恢复对话")).toBeDefined();
  });

  it("永久结束会话期间用户改选另一条：迟到的删除不清空新选择", async () => {
    const user = userEvent.setup();
    renderApp();
    await expectShelf();

    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await openHistory(user);
    await user.click(await findHistoryItem(1));
    await expectSessionSelected();

    const gate = deferred<null>();
    mocks.sessionsRemove.mockReturnValueOnce(gate.promise);
    await user.click(screen.getByLabelText("当前对话操作"));
    await user.click(screen.getByRole("button", { name: "永久结束对话" }));
    await waitFor(() => expect(mocks.sessionsRemove).toHaveBeenCalledWith("s1"));

    await openHistory(user);
    await user.click(await findHistoryItem(2));
    await expectSessionSelected();

    await act(async () => {
      gate.resolve(null);
    });

    await openHistory(user);
    await waitFor(() => expect(historyItem(2)).toHaveAttribute("aria-current", "true"));
    expect(historyItem(1)).toHaveAttribute("aria-current", "false");
  });

  it("中栏按 work 隔离：新建章节的迟到回包不会在新作品里选中章节", async () => {
    const user = userEvent.setup();
    chapterItems = { w1: [C1], w2: [] };
    renderApp();
    await expectShelf();

    const gate = deferred<Chapter>();
    mocks.chaptersCreate.mockReturnValueOnce(gate.promise);

    await openBook(user, "作品二");
    await findManuscript("作品大纲");
    // 一章都没有：新建表单按需直接展开。
    await user.type(screen.getByLabelText("新章节标题"), "迟到的章节");
    await user.click(screen.getByRole("button", { name: "新建章节" }));
    expect(mocks.chaptersCreate).toHaveBeenCalledWith("w2", { title: "迟到的章节" });

    // 创建在途时切到作品一：WorkspacePane 按 workId 重建，本地章节选择属于 w2 实例。
    await backToShelf(user);
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await act(async () => {
      gate.resolve(chapter("c-late", "w2", "迟到的章节"));
    });

    // 作品一仍旧显示自己的第一章：迟到的 w2 章节既不被选中，也不会被读取。
    expect(queryManuscript("章节正文：第一章")).not.toBeNull();
    expect(screen.queryByText(/迟到的章节/)).toBeNull();
    expect(mocks.chaptersGet.mock.calls.some(([, chapterId]) => chapterId === "c-late")).toBe(false);
  });
});

describe("App 专注模式与移动切换", () => {
  it("移动切换区用“助手”标识助手栏（不再用 Agent）", async () => {
    const user = userEvent.setup();
    renderApp();
    await expectShelf();
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    const switcher = screen.getByRole("navigation", { name: "创作区域" });
    const tab = within(switcher).getByRole("button", { name: "助手" });
    expect(tab).toHaveAttribute("aria-pressed", "false");
    expect(within(switcher).queryByRole("button", { name: "Agent" })).toBeNull();

    await user.click(tab);
    expect(tab).toHaveAttribute("aria-pressed", "true");
    expect(assistant()).toBeDefined();
  });

  it("专注写作只隐藏不卸载：助手草稿与正文都保留，退出后仍在", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await expectShelf();
    await openBook(user, "作品一");
    await findManuscript("章节正文：第一章");

    await user.type(screen.getByLabelText("消息输入"), "专注期间写的草稿");
    await user.click(screen.getByRole("button", { name: "专注写作" }));

    const layout = container.querySelector(".studio-layout");
    expect(layout).toHaveClass("is-focused");
    expect(screen.getByRole("button", { name: "退出专注" })).toBeDefined();
    // 隐藏不卸载：助手与正文仍挂载，未发送草稿与编辑器状态都不丢。
    expect(assistant()).toBeDefined();
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("专注期间写的草稿");
    expect(queryManuscript("章节正文：第一章")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "退出专注" }));
    expect(layout).not.toHaveClass("is-focused");
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("专注期间写的草稿");
    expect(queryManuscript("章节正文：第一章")).not.toBeNull();
  });
});
