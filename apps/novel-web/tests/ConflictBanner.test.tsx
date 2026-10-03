import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConflictBanner } from "../src/components/ConflictBanner";

const conflict = {
  localText: "我的本地草稿",
  expectedVersion: 2,
  serverVersion: 9,
  detectedAt: 0,
};

function renderBanner(overrides: Partial<Parameters<typeof ConflictBanner>[0]> = {}) {
  return render(
    <ConflictBanner
      conflict={conflict}
      serverText="服务端内容"
      serverVersion={9}
      onReload={vi.fn()}
      onTakeServer={vi.fn()}
      onSaveOverwrite={vi.fn()}
      reloading={false}
      saving={false}
      {...overrides}
    />,
  );
}

describe("ConflictBanner", () => {
  it("说明本地草稿已保留，并提供重新读取/采用服务端/重新提交三种选择", async () => {
    const onReload = vi.fn();
    const onTakeServer = vi.fn();
    const onSaveOverwrite = vi.fn();
    const user = userEvent.setup();

    const { container } = renderBanner({ onReload, onTakeServer, onSaveOverwrite });

    expect(screen.getByRole("alert").textContent).toContain("本地未保存内容已保留");

    // 语义阅读：本地草稿与服务端内容各渲染一处，且不丢源文。
    const readings = [...container.querySelectorAll(".comparison-reading")];
    expect(readings).toHaveLength(2);
    expect(readings[0]?.textContent).toBe("我的本地草稿");
    expect(readings[1]?.textContent).toBe("服务端内容");

    // 逐字原文保留在默认折叠的“查看原文”里。
    const sources = [...container.querySelectorAll("details.source-details")];
    expect(sources).toHaveLength(2);
    expect(sources.every((node) => !node.hasAttribute("open"))).toBe(true);
    expect(sources[0]?.querySelector("pre.code")?.textContent).toBe("我的本地草稿");
    expect(sources[1]?.querySelector("pre.code")?.textContent).toBe("服务端内容");

    await user.click(screen.getByRole("button", { name: /重新读取服务端/ }));
    await user.click(screen.getByRole("button", { name: /采用服务端内容/ }));
    await user.click(screen.getByRole("button", { name: /以最新版本提交本地草稿/ }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onTakeServer).toHaveBeenCalledTimes(1);
    expect(onSaveOverwrite).toHaveBeenCalledTimes(1);
  });

  it("尚未重新读取到服务端内容时禁用会丢弃草稿的操作", () => {
    renderBanner({ serverText: null, serverVersion: null });

    expect(screen.getByRole("button", { name: /采用服务端内容/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /以最新版本提交本地草稿/ })).toBeDisabled();
  });

  it("只有旧快照（低于冲突版本）时禁用采用/重试，并提示重新读取且保留本地草稿", async () => {
    const onTakeServer = vi.fn();
    const onSaveOverwrite = vi.fn();
    const onReload = vi.fn();
    const user = userEvent.setup();

    // 真实场景：落盘版本已是 3，但窗口里的 draft.server 还是基线 1。
    const { container } = renderBanner({
      conflict: { ...conflict, expectedVersion: 1, serverVersion: 3 },
      serverText: "服务端旧快照",
      serverVersion: 1,
      onTakeServer,
      onSaveOverwrite,
      onReload,
    });

    expect(screen.getByRole("button", { name: /采用服务端内容/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /以最新版本提交本地草稿/ })).toBeDisabled();
    expect(screen.getByRole("status").textContent).toContain("请先点“重新读取服务端”");
    expect(screen.getByRole("status").textContent).toContain("低于冲突报告的版本 3");
    // 本地草稿仍然展示，未被覆盖；原始文本仍可从“查看原文”逐字核对。
    expect(container.querySelector(".comparison-reading")?.textContent).toBe("我的本地草稿");
    expect(container.querySelector("details.source-details pre.code")?.textContent).toBe("我的本地草稿");

    await user.click(screen.getByRole("button", { name: /采用服务端内容/ }));
    await user.click(screen.getByRole("button", { name: /以最新版本提交本地草稿/ }));
    expect(onTakeServer).not.toHaveBeenCalled();
    expect(onSaveOverwrite).not.toHaveBeenCalled();

    // 重新读取始终可用。
    await user.click(screen.getByRole("button", { name: /重新读取服务端/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("快照版本与冲突版本相等时启用采用/重试", async () => {
    const onTakeServer = vi.fn();
    const onSaveOverwrite = vi.fn();
    const user = userEvent.setup();

    renderBanner({
      conflict: { ...conflict, expectedVersion: 1, serverVersion: 3 },
      serverText: "服务端版本 3 的内容",
      serverVersion: 3,
      onTakeServer,
      onSaveOverwrite,
    });

    const takeServer = screen.getByRole("button", { name: /采用服务端内容/ });
    const saveOverwrite = screen.getByRole("button", { name: /以最新版本提交本地草稿/ });
    expect(takeServer).toBeEnabled();
    expect(saveOverwrite).toBeEnabled();
    expect(screen.queryByText(/低于冲突报告的版本/)).toBeNull();

    await user.click(takeServer);
    await user.click(saveOverwrite);
    expect(onTakeServer).toHaveBeenCalledTimes(1);
    expect(onSaveOverwrite).toHaveBeenCalledTimes(1);
  });

  it("快照版本比冲突版本更新时同样允许（服务端又推进到 4）", async () => {
    const onTakeServer = vi.fn();
    const onSaveOverwrite = vi.fn();
    const user = userEvent.setup();

    renderBanner({
      conflict: { ...conflict, expectedVersion: 1, serverVersion: 3 },
      serverText: "服务端版本 4 的内容",
      serverVersion: 4,
      onTakeServer,
      onSaveOverwrite,
    });

    expect(screen.getByRole("button", { name: /采用服务端内容/ })).toBeEnabled();
    const saveOverwrite = screen.getByRole("button", { name: /以最新版本提交本地草稿/ });
    expect(saveOverwrite).toBeEnabled();

    await user.click(saveOverwrite);
    expect(onSaveOverwrite).toHaveBeenCalledTimes(1);
  });

  it("有版本号但无内容时仍视为不可用，不允许采用/重试", () => {
    renderBanner({
      conflict: { ...conflict, expectedVersion: 1, serverVersion: 3 },
      serverText: null,
      serverVersion: 3,
    });

    expect(screen.getByRole("button", { name: /采用服务端内容/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /以最新版本提交本地草稿/ })).toBeDisabled();
  });
});
