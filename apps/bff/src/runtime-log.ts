/**
 * 运行时投递/路由的最小日志接缝。
 *
 * 只要一个结构化接口（而不是把 fastify 的 logger 类型拽进来），这样单元测试
 * 可以传一个记录器，装配层可以传 pino。
 *
 * 硬性约束：日志只写标识、状态与原因字符串；**不写** token、正文、prompt 或模型输出。
 */
export interface RuntimeLogger {
  info?(message: string, detail?: Record<string, unknown>): void;
  warn?(message: string, detail?: Record<string, unknown>): void;
  error?(message: string, detail?: Record<string, unknown>): void;
}

/** 测试与"未接日志"的默认实现：什么都不做。 */
export const silentRuntimeLogger: RuntimeLogger = Object.freeze({});
