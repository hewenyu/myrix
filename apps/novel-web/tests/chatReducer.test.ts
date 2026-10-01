import type { SessionStreamEvent } from "@myrix/contracts";
import { describe, expect, it } from "vitest";

import {
  appendPendingCommand,
  applyStreamEvent,
  emptyChatState,
  markConnected,
  markDisconnected,
  visibleMessages,
} from "../src/state/chatReducer";

function reduce(events: SessionStreamEvent[]) {
  return events.reduce(applyStreamEvent, emptyChatState);
}

describe("applyStreamEvent", () => {
  it("持久事件按 seq 去重：重复投递不会产生重复消息", () => {
    const event: SessionStreamEvent = { type: "assistant", seq: 1, text: "第一段" };
    const once = applyStreamEvent(emptyChatState, event);
    const twice = applyStreamEvent(once, event);

    expect(once.messages).toHaveLength(1);
    expect(twice.messages).toHaveLength(1);
    expect(twice.lastSeq).toBe(1);
  });

  it("丢弃 seq 小于等于已应用序号的迟到事件", () => {
    const state = reduce([
      { type: "assistant", seq: 1, text: "a" },
      { type: "assistant", seq: 2, text: "b" },
    ]);
    const late = applyStreamEvent(state, { type: "assistant", seq: 1, text: "重复" });
    expect(late.messages).toHaveLength(2);
    expect(late.messages.map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("恢复种子与过滤事件造成的 seq 跳跃不被误报为丢失", () => {
    const state = reduce([
      { type: "assistant", seq: 1, text: "a" },
      { type: "assistant", seq: Number.MAX_SAFE_INTEGER, text: "c" },
    ]);
    expect(state.needsReplay).toBe(false);
    expect(state.missingSeqs).toEqual([]);
    expect(state.messages.map((m) => m.text)).toEqual(["a", "c"]);
    expect(state.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("去重窗口之外的旧事件不会在重连时再次出现", () => {
    const state = reduce([
      { type: "assistant", seq: 1, text: "a" },
      { type: "assistant", seq: 1000, text: "c" },
      { type: "assistant", seq: 1, text: "a" },
    ]);
    expect(state.messages.map((m) => m.text)).toEqual(["a", "c"]);
    expect(state.needsReplay).toBe(false);
  });

  it("只有服务端明确截断标记要求补发，非法 seq 不推进水位", () => {
    const state = reduce([
      { type: "assistant", seq: -1, text: "invalid" },
      { type: "assistant", seq: 0.5, text: "invalid" },
      { type: "status", status: "replay-required" },
      { type: "assistant", seq: 2, text: "a" },
    ]);
    expect(state.messages.map((m) => m.text)).toEqual(["a"]);
    expect(state.needsReplay).toBe(true);
  });

  it("delta 是瞬态内容，累加到同一条流式消息上", () => {
    const state = reduce([
      { type: "delta", text: "你" },
      { type: "delta", text: "好" },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.streaming).toBe(true);
    expect(state.messages[0]?.text).toBe("你好");
    expect(state.turnActive).toBe(true);
  });

  it("final 文本以持久事件为准：持久 assistant 事件替换流式内容", () => {
    const state = reduce([
      { type: "delta", text: "未落定" },
      { type: "assistant", seq: 1, text: "最终文本" },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.text).toBe("最终文本");
    expect(state.messages[0]?.streaming).toBeFalsy();
  });

  it("turn-end 不会把未持久确认的流式片段变成最终消息", () => {
    const state = reduce([
      { type: "delta", text: "部分" },
      { type: "turn-end", seq: 2 },
    ]);
    expect(state.turnActive).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.notice?.level).toBe("warn");
  });

  it("status 事件反映服务端运行态，未知取值原样保留", () => {
    const waking = applyStreamEvent(emptyChatState, { type: "status", status: "waking" });
    expect(waking.serverStatus).toBe("waking");
    expect(waking.turnActive).toBe(true);
    const unknown = applyStreamEvent(waking, { type: "status", status: "something-new" });
    expect(unknown.serverStatus).toBe("something-new");
  });

  it("error 事件给出可见提示且不伪造正文", () => {
    const state = applyStreamEvent(emptyChatState, { type: "error", text: "模型未配置" });
    expect(state.notice).toEqual({ level: "error", code: "runtime", text: "模型未配置" });
    expect(state.messages).toHaveLength(0);
  });

  it("待回显的本地命令在服务端持久事件到达后被替换，不重复显示", () => {
    const pending = appendPendingCommand(emptyChatState, "cmd-1", "写一段开头");
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]?.pending).toBe(true);

    const confirmed = applyStreamEvent(pending, { type: "user", seq: 1, text: "写一段开头", commandId: "cmd-1" });
    expect(confirmed.messages).toHaveLength(1);
    expect(confirmed.messages[0]?.pending).toBeUndefined();
    expect(confirmed.messages[0]?.seq).toBe(1);
  });

  it("真实形状：BFF 投影的 commandId 与 202 回执一致时，本机占位被持久消息精确替换", () => {
    // BFF 把 driver user/message 的 data.id 映射成公开 commandId（见 runtime-stream.ts）。
    const commandId = "72558f29-e525-4085-bfd1-991884292e5d";
    const pending = appendPendingCommand(emptyChatState, commandId, "请调用 get_outline 再 update_outline");
    expect(pending.messages).toHaveLength(1);

    const confirmed = applyStreamEvent(pending, {
      type: "user",
      seq: 5,
      text: "请调用 get_outline 再 update_outline",
      commandId,
    });
    // 恰好一条用户消息：没有 pending 副本。
    const users = confirmed.messages.filter(m => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.pending).toBeUndefined();
    expect(users[0]?.seq).toBe(5);
    expect(users[0]?.commandId).toBe(commandId);
  });

  it("反向顺序：持久 user 事件先于 202 到达时，appendPendingCommand 不再补一条 pending", () => {
    const commandId = "72558f29-e525-4085-bfd1-991884292e5d";
    // 极快 SSE：事件流先落下持久消息。
    const streamed = applyStreamEvent(emptyChatState, { type: "user", seq: 5, text: "快模型", commandId });
    expect(streamed.messages).toHaveLength(1);
    expect(streamed.turnActive).toBe(true);

    // 202 随后才回来：绝不能把已确认的命令再加回成 pending。
    const afterAck = appendPendingCommand(streamed, commandId, "快模型");
    expect(afterAck.messages).toHaveLength(1);
    expect(afterAck.messages[0]?.pending).toBeUndefined();
    expect(afterAck.messages[0]?.seq).toBe(5);
    // 也不应该重置已经推进中的回合状态。
    expect(afterAck.turnActive).toBe(true);
  });

  it("BFF 未能投影 commandId 时退化为无匹配（不会错误吞掉别的 pending）", () => {
    // 持久 user 事件没有 commandId：本机占位无法匹配，只能保留（多一条）。
    // 这是"形状不合规时省略字段"的已知退化，不能反过来拿正文去猜。
    const pending = appendPendingCommand(emptyChatState, "cmd-1", "同样正文");
    const confirmed = applyStreamEvent(pending, { type: "user", seq: 1, text: "同样正文" });
    expect(confirmed.messages).toHaveLength(2);
    expect(confirmed.messages[0]?.pending).toBe(true);
    expect(confirmed.messages[1]?.seq).toBe(1);
  });

  it("持久终态每回合只累计一次刷新计数（含中断与会话结束）", () => {
    const completed = reduce([
      { type: "user", seq: 5, text: "一轮" },
      { type: "assistant", seq: 8, text: "回复" },
      { type: "turn-end", seq: 10 },
    ]);
    expect(completed.settlements).toBe(1);
    expect(completed.settledSeq).toBe(10);
    expect(completed.serverStatus).toBeNull();

    const interrupted = applyStreamEvent(completed, { type: "status", seq: 11, status: "interrupted" });
    expect(interrupted.settlements).toBe(2);
    expect(interrupted.settledSeq).toBe(11);

    const ended = applyStreamEvent(interrupted, { type: "status", seq: 12, status: "session-ended: revoked" });
    expect(ended.settlements).toBe(3);
    expect(ended.settledSeq).toBe(12);

    const failed = applyStreamEvent(ended, { type: "error", seq: 13, text: "本轮执行失败" });
    expect(failed.settlements).toBe(4);
    expect(failed.settledSeq).toBe(13);

    // 瞬态帧不产生终态，也不累计。
    const transient = reduce([
      { type: "delta", text: "流" },
      { type: "status", status: "stream-start" },
      { type: "status", status: "stream-abandoned" },
      { type: "status", status: "stream-interrupted" },
      { type: "status", status: "replay-required" },
    ]);
    expect(transient.settlements).toBe(0);
    expect(transient.settledSeq).toBeNull();
  });

  it("驱动瞬态控制帧不写 serverStatus：运行标签不会停在 stream-start", () => {
    const streaming = reduce([
      { type: "status", status: "stream-start" },
      { type: "status", status: "stream-abandoned" },
      { type: "status", status: "stream-interrupted" },
      { type: "status", status: "replay-required" },
    ]);
    expect(streaming.serverStatus).toBeNull();
    expect(streaming.serverStatusSeq).toBeNull();

    // 持久会话状态则必须记录（含它的 seq，供运行态排序）。
    const durable = applyStreamEvent(streaming, { type: "status", seq: 30, status: "interrupted" });
    expect(durable.serverStatus).toBe("interrupted");
    expect(durable.serverStatusSeq).toBe(30);
    expect(durable.settledSeq).toBe(30);
    // 持久状态之后不再被更早的持久终态覆盖（seq 比较在 describeRunState 里做）。
    const earlierTurnEnd = applyStreamEvent(durable, { type: "turn-end", seq: 20 });
    expect(earlierTurnEnd).toEqual(durable);
  });

  it("新回合开始清掉上一轮的回合级状态，但不吞掉会话级状态", () => {
    // interrupted 是回合级：新 user 事件后不能继续显示"上一轮被中断"。
    const interrupted = reduce([
      { type: "user", seq: 5, text: "第一轮" },
      { type: "status", seq: 9, status: "interrupted" },
    ]);
    expect(interrupted.serverStatus).toBe("interrupted");
    const next = applyStreamEvent(interrupted, { type: "user", seq: 12, text: "第二轮" });
    expect(next.serverStatus).toBeNull();
    expect(next.serverStatusSeq).toBeNull();
    expect(next.turnActive).toBe(true);

    // session-ended 是会话级：新回合也不该把它抹掉（会话确实已经结束）。
    const ended = reduce([
      { type: "user", seq: 5, text: "第一轮" },
      { type: "status", seq: 9, status: "session-ended: revoked" },
    ]);
    const afterEnded = applyStreamEvent(ended, { type: "user", seq: 12, text: "第二轮" });
    expect(afterEnded.serverStatus).toBe("session-ended: revoked");
    expect(afterEnded.turnActive).toBe(true);
  });

  it("本机新提交的命令清掉上一回合终态，避免把上一轮完成误当本轮完成", () => {
    const finished = reduce([
      { type: "user", seq: 5, text: "第一轮" },
      { type: "assistant", seq: 8, text: "第一轮回复" },
      { type: "turn-end", seq: 10 },
    ]);
    expect(finished.turnOutcome).toBe("completed");

    const next = appendPendingCommand(finished, "cmd-2", "第二轮");
    expect(next.turnOutcome).toBeNull();
    expect(next.turnOutcomeReason).toBeNull();
    expect(next.turnActive).toBe(true);
    expect(next.turnPublicText).toBe(false);
    // 已确认的持久内容与新的待回显用户消息都保留。
    expect(next.messages.map(m => m.text)).toEqual(["第一轮", "第一轮回复", "第二轮"]);
  });

  it("断线只标注提示，不改变已收到的持久事件", () => {
    const state = reduce([{ type: "assistant", seq: 1, text: "已收到" }]);
    const disconnected = markDisconnected(state);
    expect(disconnected.messages).toEqual(state.messages);
    expect(disconnected.notice?.level).toBe("warn");
  });

  it("重连只清除断线提示，不吞掉回合级警告", () => {
    const disconnected = markDisconnected(emptyChatState);
    expect(disconnected.notice?.code).toBe("stream-disconnected");
    expect(markConnected(disconnected).notice).toBeNull();

    // "完成但没有公开正文"是回合级警告：重连不应该让它消失。
    const incomplete = reduce([
      { type: "user", seq: 5, text: "只调用工具" },
      { type: "turn-end", seq: 25 },
    ]);
    expect(incomplete.notice?.code).toBe("turn-incomplete");
    expect(markConnected(incomplete).notice?.code).toBe("turn-incomplete");
  });

  it("新尝试清除旧 delta，不拼接重试前缀且不删除持久回复", () => {
    const state = reduce([
      { type: "assistant", seq: 1, text: "已确认" },
      { type: "delta", text: "被重试的前缀" },
      { type: "status", status: "stream-start" },
      { type: "delta", text: "新尝试" },
    ]);
    expect(state.messages.map(m => m.text)).toEqual(["已确认", "新尝试"]);
    expect(state.messages[1]?.streaming).toBe(true);
    expect(state.turnActive).toBe(true);
    expect(state.lastSeq).toBe(1);
  });

  it.each(["stream-abandoned", "error", "disconnect"])("%s 仅丢弃瞬态内容", boundary => {
    const state = reduce([
      { type: "assistant", seq: 1, text: "已确认" },
      { type: "delta", text: "不能确认" },
    ]);
    const next = boundary === "disconnect" ? markDisconnected(state)
      : applyStreamEvent(state, boundary === "error" ? { type: "error", text: "模型中断" }
        : { type: "status", status: "stream-abandoned" });
    expect(next.messages.map(m => m.text)).toEqual(["已确认"]);
    expect(next.lastSeq).toBe(1);
  });

  it("工具事件携带工具名并按 seq 排序去重", () => {
    const state = reduce([
      { type: "tool", seq: 1, toolName: "save_chapter_draft", text: "已保存" },
      { type: "tool", seq: 1, toolName: "save_chapter_draft", text: "已保存" },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.toolName).toBe("save_chapter_draft");
  });

  it("工具调用结束后的空 assistant 消息不落成空助手泡，也不代表本回合完成", () => {
    // 真实链路：assistant/message 只含 reasoning + tool-call 块时投影为 text:""。
    const state = reduce([
      { type: "user", seq: 5, text: "读大纲并保存" },
      { type: "assistant", seq: 8, text: "" },
      { type: "tool", seq: 9, toolName: "get_outline" },
    ]);
    expect(state.messages.map(m => m.role)).toEqual(["user", "tool"]);
    expect(state.messages.some(m => m.role === "assistant")).toBe(false);
    expect(state.turnActive).toBe(true);
    expect(state.turnOutcome).toBeNull();
    expect(state.turnPublicText).toBe(false);
  });

  it("工具成功执行不是完成信号：只有持久 turn-end 才落定", () => {
    const withToolSuccess = reduce([
      { type: "user", seq: 5, text: "保存大纲" },
      { type: "assistant", seq: 8, text: "" },
      { type: "tool", seq: 9, toolName: "update_outline" },
      { type: "assistant", seq: 23, text: "" },
    ]);
    expect(withToolSuccess.turnActive).toBe(true);
    expect(withToolSuccess.turnOutcome).toBeNull();
    expect(withToolSuccess.messages.filter(m => m.role === "assistant")).toHaveLength(0);

    const completed = applyStreamEvent(withToolSuccess, { type: "turn-end", seq: 25 });
    expect(completed.turnActive).toBe(false);
    expect(completed.turnOutcome).toBe("completed");
  });

  it("真实最终正文保留，且完成终态由 turn-end 给出", () => {
    const state = reduce([
      { type: "user", seq: 5, text: "保存大纲" },
      { type: "assistant", seq: 8, text: "" },
      { type: "tool", seq: 9, toolName: "get_outline" },
      { type: "assistant", seq: 23, text: "已保存确认：现版本 v4。" },
      { type: "turn-end", seq: 25 },
    ]);
    expect(state.messages.map(m => [m.role, m.text])).toEqual([
      ["user", "保存大纲"],
      // 工具记录是过程元信息（无公开正文），不是助手回复。
      ["tool", ""],
      ["assistant", "已保存确认：现版本 v4。"],
    ]);
    expect(state.turnPublicText).toBe(true);
    expect(state.turnActive).toBe(false);
    expect(state.turnOutcome).toBe("completed");
    expect(state.notice).toBeNull();
  });

  it("完成但没有任何公开正文时给出明确提示，不把工具记录当成回复", () => {
    const state = reduce([
      { type: "user", seq: 5, text: "只调用工具" },
      { type: "tool", seq: 9, toolName: "get_outline" },
      { type: "turn-end", seq: 25 },
    ]);
    expect(state.turnOutcome).toBe("completed");
    expect(state.turnPublicText).toBe(false);
    expect(state.messages.some(m => m.role === "assistant")).toBe(false);
    expect(state.notice?.level).toBe("warn");
    expect(state.notice?.text).toContain("没有可显示的助手正文");
  });

  it("带 seq 的 error 是失败终态；无 seq 的流级错误不判定回合失败", () => {
    const failed = reduce([
      { type: "user", seq: 5, text: "生成" },
      { type: "delta", text: "未落定" },
      { type: "error", seq: 25, text: "本轮执行失败" },
    ]);
    expect(failed.turnOutcome).toBe("failed");
    expect(failed.turnActive).toBe(false);
    expect(failed.turnOutcomeReason).toBe("本轮执行失败");
    expect(failed.messages.some(m => m.streaming)).toBe(false);

    const streaming = reduce([
      { type: "user", seq: 5, text: "生成" },
      { type: "status", status: "working" },
      { type: "error", text: "会话事件流中断，请重新连接以恢复持久消息" },
    ]);
    expect(streaming.turnOutcome).toBeNull();
    expect(streaming.messages.some(m => m.streaming)).toBe(false);
    expect(streaming.notice?.level).toBe("error");
  });

  it("interrupted / session-ended 状态是终态，stream-start 不是", () => {
    const started = reduce([
      { type: "user", seq: 5, text: "生成" },
      { type: "status", status: "stream-start" },
    ]);
    expect(started.turnOutcome).toBeNull();
    expect(started.turnActive).toBe(true);

    const interrupted = applyStreamEvent(started, { type: "status", seq: 25, status: "interrupted" });
    expect(interrupted.turnOutcome).toBe("interrupted");
    expect(interrupted.turnActive).toBe(false);

    const ended = applyStreamEvent(started, { type: "status", status: "session-ended: 会话状态变为 revoked" });
    expect(ended.turnOutcome).toBe("session-ended");
    expect(ended.turnOutcomeReason).toBe("会话状态变为 revoked");
    expect(ended.turnActive).toBe(false);
  });

  it("断线清除瞬态且不产生完成终态", () => {
    const state = reduce([
      { type: "user", seq: 5, text: "生成" },
      { type: "assistant", seq: 8, text: "" },
      { type: "delta", text: "未落定片段" },
    ]);
    const disconnected = markDisconnected(state);
    expect(disconnected.messages.some(m => m.role === "assistant")).toBe(false);
    expect(disconnected.turnOutcome).toBeNull();
    expect(disconnected.notice?.level).toBe("warn");
  });

  it("空工具消息（既无工具名也无文本）不渲染元数据泡，但仍标记回合进行中", () => {
    const state = reduce([
      { type: "user", seq: 5, text: "生成" },
      { type: "tool", seq: 9 },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.turnActive).toBe(true);
    expect(state.turnOutcome).toBeNull();
  });

  it("持久 user 事件开启新回合并清掉上一回合终态", () => {
    const finished = reduce([
      { type: "user", seq: 5, text: "第一轮" },
      { type: "assistant", seq: 8, text: "第一轮回复" },
      { type: "turn-end", seq: 10 },
    ]);
    expect(finished.turnOutcome).toBe("completed");

    const next = applyStreamEvent(finished, { type: "user", seq: 12, text: "第二轮" });
    expect(next.turnOutcome).toBeNull();
    expect(next.turnActive).toBe(true);
    expect(next.turnPublicText).toBe(false);
    // 已持久内容保留。
    expect(next.messages.map(m => m.text)).toEqual(["第一轮", "第一轮回复", "第二轮"]);
  });

  it("真实链路回放：reasoning+tool-call 步骤不落泡，只有最终正文与时序终态可见", () => {
    // 取自 data/cells/.../session.v4.jsonl：seq 8/13/18 只含 reasoning + tool-call。
    const state = reduce([
      { type: "user", seq: 5, text: "请调用 get_outline 再 update_outline" },
      { type: "assistant", seq: 8, text: "" },
      { type: "tool", seq: 9, toolName: "get_outline" },
      { type: "assistant", seq: 13, text: "" },
      { type: "tool", seq: 14, toolName: "update_outline" },
      { type: "assistant", seq: 18, text: "" },
      { type: "tool", seq: 19, toolName: "get_outline" },
      { type: "assistant", seq: 23, text: "已保存确认：现版本 v4。" },
      { type: "turn-end", seq: 25 },
    ]);
    expect(state.messages.filter(m => m.role === "assistant").map(m => m.text)).toEqual(["已保存确认：现版本 v4。"]);
    expect(state.messages.filter(m => m.role === "tool").map(m => m.toolName)).toEqual(["get_outline", "update_outline", "get_outline"]);
    expect(state.turnOutcome).toBe("completed");
    expect(state.turnActive).toBe(false);
    expect(state.notice).toBeNull();
  });

  it("visibleMessages 兜底过滤空助手泡与空工具泡，保留用户/系统消息", () => {
    const state = reduce([
      { type: "user", seq: 5, text: "读大纲" },
      { type: "assistant", seq: 8, text: "" },
      { type: "assistant", seq: 8, text: "   " },
      { type: "tool", seq: 9, toolName: "get_outline" },
      { type: "assistant", seq: 23, text: "已保存。" },
    ]);
    const visible = visibleMessages(state.messages);
    expect(visible.map(m => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(visible.map(m => m.text)).toEqual(["读大纲", "", "已保存。"]);
  });
});
