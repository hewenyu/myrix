import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { clearCsrfToken } from "../src/api/csrf";
import { resetTransportState } from "../src/api/transport";

/**
 * jsdom 缺少 ProseMirror 需要的几何/命中测试 API（它据此判断选区与滚动）。
 * 这些 shim 只补齐**接口形状**，不改变任何业务断言：返回空矩形与零尺寸。
 */
function emptyRectList(): DOMRectList {
  const list = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* iterator() {
      // 空列表
    },
  };
  return list as unknown as DOMRectList;
}

function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = emptyRectList;
  Range.prototype.getBoundingClientRect = zeroRect;
}

if (typeof Element !== "undefined") {
  Element.prototype.getClientRects = emptyRectList;
  Element.prototype.scrollIntoView = () => undefined;
}

if (typeof document !== "undefined") {
  document.elementFromPoint = () => null;
}

beforeEach(() => {
  clearCsrfToken();
  resetTransportState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
