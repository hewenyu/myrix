/**
 * DSH Cordis 接口的最小结构子集。
 *
 * 为什么用 shim：plugins/* 目前不依赖已发布的 DSH 包（包名与版本仍在演进），
 * 只用结构类型描述"我们会调用的那几个成员"，以便本仓库可以独立类型检查与单测。
 * 接入 vendor/deepseek-harness 构建后，应替换为真实的 @deepseek-ai/dsh-* 类型。
 *
 * 依据（DSH 0.2.0-rc.2）：
 * - tools/pre-execute waterfall：packages/core/tools/src/index.ts:142-153
 * - ctx.tools.guard 单调 guard（只能 deny，不能反转为 allow）：同文件 1126-1142
 * - ctx.tools.restrict 工具掩码（取交集）：同文件 1097
 * - ctx.permissionPresets.set(session, name)：docs/subsystems/permission-presets.md:73
 * 详见 docs/integration/dsh-seams.md
 */

export interface ToolCallInfo {
  toolName: string;
  agentId?: string;
  sessionId?: string;
  args?: unknown;
}

export type PreExecuteResult =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason?: string }
  | { type: "cancel" };

export interface ToolMask {
  allow: string[];
  deny: string[];
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface MyrixLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface MyrixContext {
  /** 订阅 Cordis waterfall 事件；返回值会传给下一个 listener */
  on(event: "tools/pre-execute", handler: (call: ToolCallInfo) => Promise<PreExecuteResult>): void;
  tools: {
    /** 单调 guard：返回字符串即拒绝该调用 */
    guard(guard: (call: ToolCallInfo) => Promise<string | undefined> | string | undefined): void;
    /** 工具可见性掩码；多次调用取交集 */
    restrict?(mask: ToolMask): void;
    /** 注册工具（API 形态待与 DSH 源码对齐，见 docs/integration/dsh-seams.md） */
    register?(tool: RegisteredTool): void;
  };
  permissionPresets?: {
    set(sessionId: string, preset: string): void;
  };
  logger?: MyrixLogger;
}
