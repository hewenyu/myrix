import { describeRunState, describeServerStatus, describeSessionStatus } from "../src/state/status";
import { describe, expect, it } from "vitest";

describe("describeRunState", () => {
  it("没有选中会话就没有运行态", () => {
    expect(describeRunState({
      hasSession: false,
      connected: true,
      turnActive: false,
      turnOutcome: null,
      settledSeq: null,
      serverStatus: null,
      serverStatusSeq: null,
    })).toBeNull();
  });

  it("turn-end 之后回到持久终态，而不是停在瞬态 stream-start", () => {
    // 瞬态控制帧从不写 serverStatus（reducer 负责），因此这里 serverStatus 仍是 null。
    const linked = describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: "completed",
      settledSeq: 10,
      serverStatus: null,
      serverStatusSeq: null,
    });
    expect(linked).toEqual({ text: "本轮已完成", level: "ok" });

    // 进行中的回合显示"进行中"，而不是"空闲"或"完成"。
    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: true,
      turnOutcome: null,
      settledSeq: null,
      serverStatus: null,
      serverStatusSeq: null,
    })).toEqual({ text: "本轮进行中", level: "progress" });
  });

  it("连接生命周期驱动空闲/未连接，不伪造 model 就绪", () => {
    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: null,
      settledSeq: null,
      serverStatus: null,
      serverStatusSeq: null,
    })).toEqual({ text: "空闲（事件流已连接）", level: "info" });

    expect(describeRunState({
      hasSession: true,
      connected: false,
      turnActive: false,
      turnOutcome: null,
      settledSeq: null,
      serverStatus: null,
      serverStatusSeq: null,
    })).toEqual({ text: "事件流未连接", level: "warn" });
  });

  it("更晚的持久会话状态压过更早的回合终态；更早的状态不覆盖更晚的终态", () => {
    // 终态 seq 10，会话状态 seq 12（撤权）→ 会话状态胜出。
    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: "completed",
      settledSeq: 10,
      serverStatus: "session-ended: 会话状态变为 revoked",
      serverStatusSeq: 12,
    })?.text).toContain("会话已结束");

    // 会话状态 seq 8（interrupted），随后 turn-end seq 10 → 终态（已完成）胜出。
    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: "completed",
      settledSeq: 10,
      serverStatus: "interrupted",
      serverStatusSeq: 8,
    })).toEqual({ text: "本轮已完成", level: "ok" });
  });

  it("失败终态与未知持久状态都原样呈现", () => {
    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: "failed",
      settledSeq: 13,
      serverStatus: null,
      serverStatusSeq: null,
    })).toEqual({ text: "本轮执行失败", level: "error" });

    expect(describeRunState({
      hasSession: true,
      connected: true,
      turnActive: false,
      turnOutcome: null,
      settledSeq: null,
      serverStatus: "model-not-configured",
      serverStatusSeq: 3,
    })).toEqual({ text: "未配置可用模型，请联系管理员", level: "error" });
  });
});

describe("status labels", () => {
  it("未识别的服务端状态与会话状态原样展示", () => {
    expect(describeServerStatus("something-new")).toEqual({ text: "something-new", level: "info" });
    expect(describeSessionStatus("active")).toEqual({ text: "活跃", level: "info" });
    expect(describeSessionStatus("weird" as never)).toEqual({ text: "weird", level: "info" });
  });
});
