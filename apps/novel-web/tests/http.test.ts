import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "../src/api/csrf";
import {
  CellUnavailableError,
  ConflictError,
  MyrixApiError,
  NetworkError,
  UnauthorizedError,
} from "../src/api/errors";
import { requestJson } from "../src/api/http";
import { getTransportState } from "../src/api/transport";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function fetchMock(): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("requestJson", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET 请求只依赖同源 cookie，不发送 CSRF 头，也不发送任何身份字段", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ items: [] }));
    setCsrfToken("csrf-1");

    await requestJson("/works");

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/works");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    const headers = init.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBeNull();
    expect(headers.get("X-Actor")).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it("写请求携带 CSRF token 与 JSON 请求体", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ id: "w1" }));
    setCsrfToken("csrf-2");

    await requestJson("/works", { method: "POST", body: { title: "标题", description: "" } });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/works");
    expect(init.method).toBe("POST");
    const headers = init.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-2");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ title: "标题", description: "" });
  });

  it("204 返回 null", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(requestJson("/works/w1", { method: "DELETE" })).resolves.toBeNull();
  });

  it("401 抛出 UnauthorizedError 并携带服务端原因", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ error: "unauthorized", reason: "会话已过期" }, { status: 401 }));
    await expect(requestJson("/works")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("409 抛出 ConflictError 并保留服务端版本号", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ status: "conflict", version: 7 }, { status: 409 }));

    try {
      await requestJson("/works/w1/outline", { method: "PUT", body: { text: "x", expectedVersion: 3 } });
      throw new Error("应当抛出错误");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).result).toEqual({ status: "conflict", version: 7 });
    }
  });

  it("503 抛出 CellUnavailableError 并读取标准 Retry-After 头", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(
      jsonResponse(
        { error: "cell-unavailable", reason: "运行单元正在唤醒" },
        { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "12" } },
      ),
    );

    try {
      await requestJson("/sessions/s1/messages", { method: "POST", body: {} });
      throw new Error("应当抛出错误");
    } catch (error) {
      expect(error).toBeInstanceOf(CellUnavailableError);
      expect((error as CellUnavailableError).retryAfterSeconds).toBe(12);
    }
  });

  it("其它错误码使用 { error, reason } 中的 reason 作为消息", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ error: "forbidden", reason: "不是作品所有者" }, { status: 403 }));

    try {
      await requestJson("/works/w2");
      throw new Error("应当抛出错误");
    } catch (error) {
      expect(error).toBeInstanceOf(MyrixApiError);
      expect((error as MyrixApiError).message).toBe("不是作品所有者");
      expect((error as MyrixApiError).status).toBe(403);
    }
  });

  it("网络失败抛出 NetworkError 并把传输状态标记为不可达", async () => {
    const mock = fetchMock();
    mock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(requestJson("/works")).rejects.toBeInstanceOf(NetworkError);
    expect(getTransportState().reachable).toBe(false);
  });

  it("成功响应把传输状态标记为可达", async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(jsonResponse({ items: [] }));
    await requestJson("/works");
    expect(getTransportState().reachable).toBe(true);
    expect(getTransportState().lastOkAt).not.toBeNull();
  });
});
