/**
 * **明确的测试替身**：一个无密钥的模型适配器。
 *
 * 它存在的唯一目的是让 `dsh-agent-loop` 有一个可解析的路由（`stub-model`），
 * 使组合测试可以创建 Agent。它**不是**模型验收：
 * - 不理解任何提示，不调用任何网络；
 * - 只按脚本回一段固定文本，或按预置脚本回一次工具调用；
 * - 因此本目录的任何测试都**不能**被引用为"真实 provider/model 可用"。
 *
 * 真实模型回合的验收必须在部署环境里用真实 provider 完成，且要覆盖
 * provider 归因、额度与撤权路径。
 *
 * @module tests/stub-model
 */
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 一次被观察到的（替身）模型调用。 */
export interface StubModelCall {
  readonly provider: string
  readonly model: string
  readonly sessionId: string | null
  readonly purpose: string | null
  readonly messageCount: number
}

/** 替身脚本：给定第 N 次调用，返回要产出的 chunk 序列。 */
export type StubScript = (call: StubModelCall, index: number) => readonly StreamChunk[]

/**
 * 无密钥模型适配器替身。
 *
 * 默认每个回合只回一段文本；测试可以 `script()` 注入工具调用回合。
 */
export class StubModelAdapter extends LlmAdapter {
  /** 观察到的调用，最新在后。 */
  readonly calls: StubModelCall[] = []

  private scripted: StubScript = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'stub-model: 测试替身回复' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'stub-model: 测试替身回复' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  /** 覆盖脚本；返回复位函数。 */
  script(next: StubScript): () => void {
    const previous = this.scripted
    this.scripted = next
    return () => { this.scripted = previous }
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 64_000 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call: StubModelCall = {
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId ?? null,
      purpose: options.purpose ?? null,
      messageCount: options.messages.length,
    }
    this.calls.push(call)
    yield* this.scripted(call, this.calls.length - 1)
  }
}
