import { describe, expect, it } from "vitest";
import { diffMask, toToolMask } from "../src/tool-mask";

const owners = [
  { pluginId: "dsh-base", tools: ["bash", "fs_read"] },
  { pluginId: "tool-computer-use", tools: ["computer_use"] },
  { pluginId: "myrix-plugin-knowledge", tools: ["myrix_kb_search"] },
];

describe("toToolMask", () => {
  it("未授权插件的工具进入 deny，且 deny 覆盖 allow", () => {
    const mask = toToolMask(["dsh-base", "myrix-plugin-knowledge"], owners);
    expect(mask).toEqual({
      allow: ["bash", "fs_read", "myrix_kb_search"],
      deny: ["computer_use"],
    });
  });

  it("没有归属信息时不施加掩码（避免误禁全部工具）", () => {
    expect(toToolMask(["dsh-base"], [])).toBeUndefined();
  });

  it("同一工具被多个插件声明时，只要任一插件禁用即 deny", () => {
    const shared = [
      { pluginId: "a", tools: ["x"] },
      { pluginId: "b", tools: ["x"] },
    ];
    expect(toToolMask(["a"], shared)).toEqual({ allow: [], deny: ["x"] });
  });
});

describe("diffMask", () => {
  it("给出新增与移除的工具，便于审计下发变更", () => {
    const before = toToolMask(["dsh-base"], owners);
    const after = toToolMask(["dsh-base", "myrix-plugin-knowledge"], owners);
    expect(diffMask(before, after)).toEqual({ added: ["myrix_kb_search"], removed: [] });
  });
});
