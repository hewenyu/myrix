/**
 * Keyless model adapter for the Myrix runtime PoC.
 *
 * This stands in for the real provider wiring (`myrix-llm-gateway`): it proves
 * the loop reaches an adapter at all, and records the exact `GenerateOptions`
 * fields the gateway would need for attribution (`sessionId`, `purpose`).
 *
 * It is deliberately NOT a mock of DSH: the session store, agent loop, tool
 * registry, preset registry and JSONL persistence are all the real ones.
 *
 * Usage is synthesized, not observed. A real provider reports what the request
 * actually cost; this in-memory stand-in prices the exact request it was handed
 * with the locked `@deepseek-ai/dsh-token-meter/estimate` heuristic, so the
 * deterministic replies carry a request-sized usage sample instead of the fixed
 * `7/3` sample. That keeps the token meter's pressure sample consistent with
 * the content the real compaction engine prices, which is what lets a
 * genuinely compactable history pass the engine's "summary is smaller" check.
 * This is explicitly an in-memory model substitute for the real-DSH probe; it
 * is NOT an HTTP-provider acceptance, and it implements no completion protocol.
 * @module myrix-poc-mock-llm
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ROLE_OVERHEAD, estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'

/** One observed model call, flattened for the report. */
const calls = []

/** @returns the recorded calls, newest last. */
export function observedCalls() {
  return calls
}

/**
 * Deterministically price the exact request the adapter received.
 * @param {readonly ({ role?: string, content: readonly object[] })[]} messages - request messages, exactly as sent.
 * @returns input tokens under the locked fixed-density estimator.
 */
function requestInputTokens(messages) {
  return messages.reduce((total, message) => total + estimateMessage(/** @type {never} */ (message)), 0)
}

/**
 * Deterministically price one assistant text reply under the same estimator.
 * @param {string} text - the exact reply text yielded to the caller.
 * @returns output tokens, matching how the meter prices an assistant node.
 */
function replyOutputTokens(text) {
  return estimateContent([{ type: 'text', text }]) + ROLE_OVERHEAD
}

/** Records each call and answers with one deterministic text block. */
class PocMockAdapter extends LlmAdapter {
  /**
   * @param {string} provider - the registered route.
   * @param {string} model - the requested model id.
   */
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } }
  }

  /**
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - the assembled request.
   */
  async *stream(options) {
    const text = options.purpose === undefined ? 'myrix-poc-reply' : `myrix-poc-${options.purpose}`
    const usage = {
      inputTokens: requestInputTokens(options.messages),
      outputTokens: replyOutputTokens(text),
    }
    calls.push({
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId ?? null,
      purpose: options.purpose ?? null,
      messageCount: options.messages.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'myrix-poc-mock-llm'
export const inject = ['llm']

/**
 * Register the keyless `poc-mock` route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the owning context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['poc-mock'], new PocMockAdapter())
}
