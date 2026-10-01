/**
 * draft.ts 纯函数不变量：观测单调性与迟到保存确认不回退。
 *
 * 反例先行：本文件的两个 describe 中的“迟到”用例在修复前必须失败，
 * 用于证伪旧实现把旧版本观测/旧 ack 写回已推进的状态。
 */
import { describe, expect, it } from "vitest";

import {
  acceptServer,
  hasNewerServerVersion,
  initDraft,
  isDirty,
  observeServer,
  resolveSaved,
  updateDraftText,
} from "../src/state/draft";

interface Doc {
  text: string;
  version: number;
}

const v0: Doc = { text: "初始 v0", version: 0 };
const v1: Doc = { text: "v1 正文", version: 1 };
const v2: Doc = { text: "v2 服务端正文", version: 2 };
const v3: Doc = { text: "v3 模型正文", version: 3 };

describe("observeServer 单调性：迟到的旧 GET 不得回退基线/观测/文本", () => {
  it("clean：已保存 v2 后再观测到迟到 v1，基线/观测/文本/notice 全部保持 v2", () => {
    const clean = initDraft(v2);
    clean.notice = "已保存为版本 2";

    const result = observeServer(clean, v1);

    expect(result.text).toBe("v2 服务端正文");
    expect(result.base).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(isDirty(result)).toBe(false);
    expect(result.notice).toBe("已保存为版本 2");
  });

  it("dirty：已观测 v2 且本地有草稿，迟到 v1 不得把 server 从 v2 降回 v1", () => {
    const baseline = initDraft(v1);
    const dirty = updateDraftText(baseline, "本地草稿");
    const observed = observeServer(dirty, v2);
    expect(observed.server).toEqual({ text: "v2 服务端正文", version: 2 });

    const result = observeServer(observed, v1);

    expect(result.text).toBe("本地草稿");
    expect(result.base).toEqual({ text: "v1 正文", version: 1 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(isDirty(result)).toBe(true);
    expect(hasNewerServerVersion(result)).toBe(true);
  });

  it("dirty 且尚未观测到更高版本时，迟到低于基线的 GET 也被忽略", () => {
    const dirty = updateDraftText(initDraft(v2), "本地草稿");

    const result = observeServer(dirty, v1);

    expect(result.text).toBe("本地草稿");
    expect(result.base).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(isDirty(result)).toBe(true);
  });

  it("保留 clean 采纳：更新的 GET 仍成为新基线与文本", () => {
    const clean = initDraft(v2);

    const result = observeServer(clean, v3);

    expect(result.base).toEqual({ text: "v3 模型正文", version: 3 });
    expect(result.server).toEqual({ text: "v3 模型正文", version: 3 });
    expect(result.text).toBe("v3 模型正文");
    expect(isDirty(result)).toBe(false);
  });

  it("保留 dirty 只更新观测：更高版本不覆盖本地草稿，基线不动", () => {
    const dirty = updateDraftText(initDraft(v1), "本地草稿");

    const result = observeServer(dirty, v2);

    expect(result.base).toEqual({ text: "v1 正文", version: 1 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.text).toBe("本地草稿");
    expect(isDirty(result)).toBe(true);
    expect(hasNewerServerVersion(result)).toBe(true);
  });
});

describe("resolveSaved 迟到确认：base 已推进到更高版本时不得回退", () => {
  it("显式 acceptServer(v2) 后迟到 save v1：保留当前草稿/基线/观测，不产生虚假 dirty", () => {
    const submitted = updateDraftText(initDraft(v0), "提交时的内容");
    const accepted = acceptServer(submitted, v2);
    expect(accepted.base).toEqual({ text: "v2 服务端正文", version: 2 });

    const result = resolveSaved(accepted, { text: "提交时的内容", version: 1 });

    expect(result.base).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.text).toBe("v2 服务端正文");
    expect(isDirty(result)).toBe(false);
    expect(result.conflict).toBeNull();
  });

  it("clean 已采纳 v2 后迟到 save v1：旧 ack 不清除新状态", () => {
    const clean = initDraft(v2);

    const result = resolveSaved(clean, { text: "提交时的内容", version: 1 });

    expect(result.base).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.text).toBe("v2 服务端正文");
    expect(isDirty(result)).toBe(false);
  });

  it("保留：base v0 / server v2 且确实继续输入，确认 v1 后 base 推进 v1、server 保持 v2、dirty 保持", () => {
    const submitted = updateDraftText(initDraft(v0), "提交时的内容");
    const observed = observeServer(submitted, v2);
    const typed = updateDraftText(observed, "保存后继续输入的内容");

    const result = resolveSaved(typed, { text: "提交时的内容", version: 1 });

    expect(result.base).toEqual({ text: "提交时的内容", version: 1 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.text).toBe("保存后继续输入的内容");
    expect(isDirty(result)).toBe(true);
    expect(hasNewerServerVersion(result)).toBe(true);
    expect(result.notice).toBe("已保存为版本 1");
  });

  it("保留：base v0 / server v2 且未继续输入，确认 v1 后采用已观测 v2（clean）", () => {
    const submitted = updateDraftText(initDraft(v0), "提交时的内容");
    const observed = observeServer(submitted, v2);

    const result = resolveSaved(observed, { text: "提交时的内容", version: 1 });

    expect(result.base).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.server).toEqual({ text: "v2 服务端正文", version: 2 });
    expect(result.text).toBe("v2 服务端正文");
    expect(isDirty(result)).toBe(false);
  });

  it("保留：无更高观测时，普通保存确认仍推进基线并 clean", () => {
    const submitted = updateDraftText(initDraft(v1), "提交时的内容");

    const result = resolveSaved(submitted, { text: "提交时的内容", version: 2 });

    expect(result.base).toEqual({ text: "提交时的内容", version: 2 });
    expect(result.text).toBe("提交时的内容");
    expect(isDirty(result)).toBe(false);
    expect(result.notice).toBe("已保存为版本 2");
  });

  it("保留：无更高观测时，保存后继续输入保留正文并仍 dirty", () => {
    const submitted = updateDraftText(initDraft(v1), "提交时的内容");
    const typed = updateDraftText(submitted, "保存后继续输入的内容");

    const result = resolveSaved(typed, { text: "提交时的内容", version: 2 });

    expect(result.base).toEqual({ text: "提交时的内容", version: 2 });
    expect(result.text).toBe("保存后继续输入的内容");
    expect(isDirty(result)).toBe(true);
    expect(result.notice).toBe("已保存为版本 2");
  });
});
