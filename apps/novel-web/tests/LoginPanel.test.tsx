import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoginPanel } from "../src/components/LoginPanel";

describe("LoginPanel", () => {
  it("development 模式显示三个预置测试身份，且没有任意用户 ID 输入", async () => {
    const devLogin = vi.fn();
    const user = userEvent.setup();
    render(
      <LoginPanel
        config={{ mode: "development", loginUrl: "/auth/login" }}
        loading={false}
        error={null}
        devLogin={devLogin}
        devLoginPending={false}
        devLoginError={null}
        loginWithOidc={vi.fn()}
      />,
    );

    expect(screen.getByText(/开发模式/)).toBeDefined();
    expect(screen.getByRole("button", { name: "作者 author" })).toBeDefined();
    expect(screen.getByRole("button", { name: "编辑 editor" })).toBeDefined();
    expect(screen.getByRole("button", { name: "其它租户 other-tenant" })).toBeDefined();
    // 不允许输入任意用户 ID，只能选服务端预置身份。
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "作者 author" }));
    expect(devLogin).toHaveBeenCalledWith("author");
  });

  it("oidc 模式只显示 OIDC 登录入口，不显示测试身份", () => {
    render(
      <LoginPanel
        config={{ mode: "oidc", loginUrl: "https://idp.example.com/authorize" }}
        loading={false}
        error={null}
        devLogin={vi.fn()}
        devLoginPending={false}
        devLoginError={null}
        loginWithOidc={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /OIDC/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "作者 author" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑 editor" })).toBeNull();
  });

  it("开发身份登录失败时展示服务端原因", () => {
    render(
      <LoginPanel
        config={{ mode: "development", loginUrl: "/auth/login" }}
        loading={false}
        error={null}
        devLogin={vi.fn()}
        devLoginPending={false}
        devLoginError="开发模式仅在 loopback 下可用"
        loginWithOidc={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("开发模式仅在 loopback 下可用");
  });

  it("配置读取失败时不显示任何登录按钮", () => {
    render(
      <LoginPanel
        config={undefined}
        loading={false}
        error="无法读取认证配置，请确认 BFF 已启动。"
        devLogin={vi.fn()}
        devLoginPending={false}
        devLoginError={null}
        loginWithOidc={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("无法读取认证配置");
  });
});
