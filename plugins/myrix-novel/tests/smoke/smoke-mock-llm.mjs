/**
 * 冒烟用的**无密钥模型替身**：只为让 `dsh-agent-loop` 有可解析路由。
 * 它不理解任何提示，也不调用网络；冒烟结论**不构成模型验收**。
 * @module myrix-novel-smoke-mock-llm
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class SmokeAdapter extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'smoke-stub' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'smoke-stub' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'myrix-novel-smoke-mock-llm'
export const inject = ['llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['stub'], new SmokeAdapter()))
}
