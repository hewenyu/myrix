import type { Work } from "@myrix/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkListPanel, type WorkListPanelProps } from "../src/panels/WorkListPanel";

/**
 * 书架面板的真实组件测试：新建书本弹窗、搜索过滤、删除二次确认。
 *
 * 这些都是**真实实现**（本地展开状态、过滤、确认状态），只替换调用方回调网络边界。
 * 断言聚焦行为与可读文案，不依赖 class 名。
 */

const ISO = "2026-01-01T00:00:00.000Z";

function work(id: string, title: string, description = ""): Work {
  return { id, tenantId: "t1", ownerUserId: "u1", title, description, createdAt: ISO, updatedAt: ISO };
}

const W1 = work("w1", "长夜将尽", "一个人和一座城");
const W2 = work("w2", "Alpha 计划", "The last signal");

function panelProps(overrides: Partial<WorkListPanelProps> = {}): WorkListPanelProps {
  return {
    works: [W1, W2],
    isLoading: false,
    error: null,
    selectedWorkId: null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    createPending: false,
    createError: null,
    onDelete: vi.fn(),
    deletePending: false,
    onReload: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<WorkListPanelProps> = {}) {
  const props = panelProps(overrides);
  return { props, ...render(<WorkListPanel {...props} />) };
}

/** 打开某本书的“管理书本”details 并点“删除书本”，进入二次确认。 */
async function askToDelete(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  const summary = screen.getByLabelText(`管理书本：${title}`);
  const card = summary.closest("article");
  if (!card) throw new Error(`没有找到《${title}》的卡片`);
  await user.click(summary);
  await user.click(within(card).getByRole("button", { name: "删除书本" }));
}

describe("WorkListPanel 新建书本弹窗", () => {
  it("默认不显示表单，点“新建书本”才展开；空书名不可提交", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: /新建书本/ }));

    expect(screen.getByRole("dialog", { name: "开启一个新故事" })).toBeDefined();
    expect(screen.getByRole("button", { name: "创建并开始写作" })).toBeDisabled();

    await user.type(screen.getByLabelText("书名"), "   ");
    expect(screen.getByRole("button", { name: "创建并开始写作" })).toBeDisabled();
  });

  it("提交时只把去空白的书名/简介交给 onCreate，成功后不自动关闭（由调用方/重渲染决定）", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    renderPanel({ onCreate });
    await user.click(screen.getByRole("button", { name: /新建书本/ }));

    await user.type(screen.getByLabelText("书名"), "  新故事  ");
    await user.type(screen.getByLabelText(/简介/), "  一个人  ");
    await user.click(screen.getByRole("button", { name: "创建并开始写作" }));

    expect(onCreate).toHaveBeenCalledWith({ title: "新故事", description: "一个人" });
  });

  it("创建中禁用关闭与提交并显示进行中；createError 展示服务端原因", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { rerender } = renderPanel({ onCreate });
    await user.click(screen.getByRole("button", { name: /新建书本/ }));
    await user.type(screen.getByLabelText("书名"), "新故事");

    rerender(<WorkListPanel {...panelProps({ onCreate, createPending: true, createError: "标题过长" })} />);

    expect(screen.getByRole("button", { name: "正在创建…" })).toBeDisabled();
    expect(screen.getByLabelText("关闭新建书本")).toBeDisabled();
    expect(screen.getByRole("alert").textContent).toContain("标题过长");

    // 提交是受控的：pending 期间按 Enter 不会再发一次。
    await user.keyboard("{Enter}");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("Escape 关闭弹窗，但创建进行中不关闭", async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    await user.click(screen.getByRole("button", { name: /新建书本/ }));
    await user.type(screen.getByLabelText("书名"), "新故事");

    rerender(<WorkListPanel {...panelProps({ createPending: true })} />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    rerender(<WorkListPanel {...panelProps()} />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("空书架给出引导，并可再次打开创建弹窗", async () => {
    const user = userEvent.setup();
    renderPanel({ works: [] });

    expect(screen.getByText("每个故事，都始于一个想法")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "创建第一本书" }));
    expect(screen.getByRole("dialog", { name: "开启一个新故事" })).toBeDefined();
  });
});

describe("WorkListPanel 搜索", () => {
  it("按书名或简介过滤（忽略大小写与首尾空白），无匹配给出提示", async () => {
    const user = userEvent.setup();
    renderPanel();

    const search = screen.getByLabelText("搜索书本");
    await user.type(search, " alpha ");
    expect(screen.getByRole("heading", { name: "Alpha 计划" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "长夜将尽" })).toBeNull();

    await user.clear(search);
    await user.type(search, "一座城");
    expect(screen.getByRole("heading", { name: "长夜将尽" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Alpha 计划" })).toBeNull();

    await user.clear(search);
    await user.type(search, "不存在的书");
    expect(screen.getByText("没有找到这本书，试试其他关键词。")).toBeDefined();
    expect(screen.queryByLabelText("打开书本：长夜将尽")).toBeNull();
  });

  it("过滤只影响可见卡片，书架计数仍是全部作品", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText("搜索书本"), "alpha");
    expect(screen.getByRole("heading", { name: /我的书架/ }).textContent).toContain("2");
  });
});

describe("WorkListPanel 删除二次确认", () => {
  it("删除书本先弹确认；保留则完全不调用 onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderPanel({ onDelete });

    await askToDelete(user, "长夜将尽");
    expect(screen.getByRole("alertdialog", { name: "删除这本书？" })).toBeDefined();
    expect(screen.getByText(/会撤销所有关联对话/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "保留书本" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("确认删除才把对应 workId 交给 onDelete，并关闭确认框", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderPanel({ onDelete });

    await askToDelete(user, "Alpha 计划");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("w2");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("删除进行中确认按钮禁用，避免重复提交", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { rerender } = renderPanel({ onDelete });
    await askToDelete(user, "长夜将尽");

    rerender(<WorkListPanel {...panelProps({ onDelete, deletePending: true })} />);
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("WorkListPanel 打开与加载/错误态", () => {
  it("点封面把 workId 交给 onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPanel({ onSelect });

    await user.click(screen.getByLabelText("打开书本：长夜将尽"));
    expect(onSelect).toHaveBeenCalledWith("w1");
  });

  it("加载中不显示空态；错误态可重试", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    const { rerender } = renderPanel({ works: [], isLoading: true, onReload });

    expect(screen.getByRole("status").textContent).toContain("正在整理你的书架");
    expect(screen.queryByText("每个故事，都始于一个想法")).toBeNull();

    rerender(<WorkListPanel {...panelProps({ works: [], error: "书架读取失败", onReload })} />);
    expect(screen.getByRole("alert").textContent).toContain("书架读取失败");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // 有错误时不显示“空书架”引导，避免把故障说成没有作品。
    expect(screen.queryByText("每个故事，都始于一个想法")).toBeNull();
  });
});
