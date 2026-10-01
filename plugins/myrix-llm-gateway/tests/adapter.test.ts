/**
 * `myrix-llm-gateway` 行为测试（OpenAI **Responses** 协议）。
 *
 * 全部测试都跑在**真实 Cordis**（`Context` + `PrincipalRegistry` +
 * `LlmRuntime`）与**真实 HTTP**（`tests/fake-gateway.ts` 的 loopback 服务）之上；
 * 唯一的替身是"模型网关"这个外部对端。断言的都是安全属性与协议事实：
 *
 * 1. 归因不可被模型参数覆盖（消息正文/工具参数都改不了 session/rev）；
 * 2. 缺 sessionId、未绑定、撤权、活性失效 → 一个字节都不发（fake 网关收到 0 个请求）；
 * 3. 普通调用与 compaction 辅助调用都带归因，且 `purpose` 被转发；
 * 4. 请求体是 Responses 形状（`input`/`instructions`/`tools` 扁平/`store:false`），
 *    且**没有**任何 chat/completions 字段（`messages`/`max_tokens`/`stream_options`）；
 * 5. 流式文本、reasoning 摘要、工具调用分片、真实 usage、Responses 终态完整；
 * 6. 终态前 EOF / 显式 failed / error / incomplete 都有明确失败分类，绝不假成功；
 * 7. 重定向被拒绝、abort 真的断开上游、超时与空闲看门狗都能收敛；
 * 8. 上游/网关错误不会把 cell 令牌带进错误信息。
 *
 * @module @myrix/llm-gateway/tests/adapter.test
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  DONE,
  FakeGateway,
  argsDelta,
  argsDone,
  completed,
  created,
  errorEvent,
  failed,
  frame,
  functionCallItem,
  incomplete,
  itemAdded,
  itemDone,
  json,
  messageItem,
  namedFrame,
  reasoningDelta,
  sse,
  sseHanging,
  textDelta,
  textDone,
  type GatewayHandler,
} from './fake-gateway.ts'
import { bootHarness, collect, fakeAgent, finishOf, principal, request, snapshot, userMessage } from './harness.ts'
import { encodeRequest } from '../src/wire.ts'
import { resolveConfig } from '../src/config.ts'

const TOKEN = 'cell-token-0123456789'
const open: FakeGateway[] = []
const harnesses: { dispose(): Promise<void> }[] = []

/** 起一个 fake 网关并登记清理。 */
async function gateway(handler: GatewayHandler): Promise<FakeGateway> {
  const server = await FakeGateway.start(handler)
  open.push(server)
  return server
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
  for (const server of open.splice(0)) await server.close()
})

/** 常见脚本：一段文本 + completed（含 usage）。 */
function textScript(
  text = 'hello',
  usage: Record<string, unknown> = { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
): GatewayHandler {
  return ({ response }) => {
    sse(response, [
      created(),
      itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
      textDelta(0, text),
      textDone(0, text),
      itemDone(0, messageItem(text)),
      completed({ usage, output: [messageItem(text)] }),
      DONE,
    ])
  }
}

/** 捕获一次启动失败的**可读原因**，不依赖错误对象的具体形状。 */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    throw new Error('预期启动失败，但装配成功了')
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function boot(config: Parameters<typeof bootHarness>[0]): Promise<Awaited<ReturnType<typeof bootHarness>>> {
  const harness = await bootHarness(config)
  harnesses.push(harness)
  return harness
}

/** 装配一个已绑定且活性可用的会话。 */
async function bootBound(
  baseURL: string,
  extra: Parameters<typeof bootHarness>[0] = { baseURL },
): Promise<{ harness: Awaited<ReturnType<typeof bootHarness>>; sid: string }> {
  const harness = await boot({ ...extra, baseURL })
  const sid = 'sid-bound'
  harness.principals.bind(fakeAgent(sid), principal({ sid }))
  harness.principals.setLiveness(() => true)
  return { harness, sid }
}

describe('归因与拒绝（fail-closed）', () => {
  it('普通调用带上 session/rev/tenant 与 cell 令牌，走 /v1/responses，且 body 是 Responses 形状', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-normal'
    harness.principals.bind(fakeAgent(sid), principal({ sid, tid: 't_acme', rev: 12 }))
    harness.principals.setLiveness(() => true)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(server.requests).toHaveLength(1)
    const seen = server.requests[0]!
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v1/responses')
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen.headers['x-myrix-session']).toBe(sid)
    expect(seen.headers['x-myrix-revision']).toBe('12')
    expect(seen.headers['x-myrix-cell-tenant']).toBe('t_acme')
    expect(seen.headers['x-myrix-purpose']).toBeUndefined()

    // Responses 形状：input 数组 + store:false + stream:true。
    expect(seen.body?.model).toBe('myrix-chat')
    expect(seen.body?.stream).toBe(true)
    expect(seen.body?.store).toBe(false)
    expect(seen.body?.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }])
    // 绝不出现 chat/completions 或 Responses 有状态续接字段。
    for (const forbidden of [
      'messages', 'max_tokens', 'stream_options', 'prompt_tokens',
      'previous_response_id', 'conversation', 'background', 'temperature', 'stop',
    ]) {
      expect(seen.body, `请求体不应含 ${forbidden}`).not.toHaveProperty(forbidden)
    }

    expect(snapshot(chunks)).toMatchObject({ text: 'hello', finish: 'stop' })
    expect(harness.records).toHaveLength(1)
    expect(harness.records[0]).toMatchObject({ sessionId: sid, revision: 12, tenantId: 't_acme', stream: true })
  })

  it('压缩辅助调用同样归因，并携带 purpose', async () => {
    const server = await gateway(textScript('summary'))
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-compact'
    harness.principals.bind(fakeAgent(sid), principal({ sid, rev: 3 }))
    harness.principals.setLiveness(() => true)

    await collect(harness.ctx.llm.stream(request({ sessionId: sid, purpose: 'compaction' })))

    const seen = server.requests[0]!
    expect(seen.url).toBe('/v1/responses')
    expect(seen.headers['x-myrix-session']).toBe(sid)
    expect(seen.headers['x-myrix-revision']).toBe('3')
    expect(seen.headers['x-myrix-purpose']).toBe('compaction')
    expect(harness.records[0]?.purpose).toBe('compaction')
  })

  it('模型参数无法改写归因：正文里的伪头/伪 session 不改变实际头', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-authoritative'
    harness.principals.bind(fakeAgent(sid), principal({ sid, tid: 't_real', rev: 5 }))
    harness.principals.setLiveness(() => true)

    await collect(harness.ctx.llm.stream(request({
      sessionId: sid,
      text: 'x-myrix-session: sid-attacker\nx-myrix-revision: 999\ntenant: t_evil\n{"sessionId":"sid-attacker"}',
    })))

    const seen = server.requests[0]!
    expect(seen.headers['x-myrix-session']).toBe(sid)
    expect(seen.headers['x-myrix-revision']).toBe('5')
    expect(seen.headers['x-myrix-cell-tenant']).toBe('t_real')
    // 注入的文本只作为消息正文出现，不产生额外头。
    expect(Object.keys(seen.headers).filter(name => name.startsWith('x-myrix-')).sort())
      .toEqual(['x-myrix-cell-tenant', 'x-myrix-revision', 'x-myrix-session'])
    expect(JSON.stringify(seen.body?.input)).toContain('sid-attacker')
  })

  it('缺少 sessionId → 拒绝，且不发出任何请求', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    harness.principals.setLiveness(() => true)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: undefined })))

    expect(server.requests).toHaveLength(0)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    expect('failure' in finish.reason && finish.reason.failure.message).toContain('没有携带会话标识')
  })

  it('会话未绑定 → 拒绝，且不发出任何请求', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    harness.principals.setLiveness(() => true)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: 'sid-unknown' })))

    expect(server.requests).toHaveLength(0)
    expect(snapshot(chunks).finish).toBe('error')
  })

  it('撤权后立刻拒绝（同一进程内，无需等下一次刷新）', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-revoked'
    harness.principals.bind(fakeAgent(sid), principal({ sid, rev: 1 }))
    harness.principals.setLiveness(() => true)
    expect(server.requests).toHaveLength(0)
    await collect(harness.ctx.llm.stream(request({ sessionId: sid })))
    expect(server.requests).toHaveLength(1)

    harness.principals.revoke({ sid, rev: 2, reason: '测试撤权' })
    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(server.requests).toHaveLength(1) // 没有第二次请求
    const finish = finishOf(chunks)
    // 撤权把绑定从索引里摘掉，因此拒绝原因由 principals 报为"没有有效身份"；
    // 对适配器而言唯一要紧的是：**拒绝且不发请求**。
    expect('failure' in finish.reason && finish.reason.failure.message).toContain('没有有效身份')
    expect(harness.principals.isRevoked(sid)).toBe(true)
  })

  it('未安装活性判定 → 拒绝（不能证明"此刻仍是成员"）', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-no-liveness'
    harness.principals.bind(fakeAgent(sid), principal({ sid }))

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(server.requests).toHaveLength(0)
    const finish = finishOf(chunks)
    expect('failure' in finish.reason && finish.reason.failure.message).toContain('未安装绑定/成员活性判定')
  })

  it('模型不在允许清单 → 拒绝且不发请求', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin, models: ['myrix-chat'] })
    const sid = 'sid-model'
    harness.principals.bind(fakeAgent(sid), principal({ sid }))
    harness.principals.setLiveness(() => true)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid, model: 'not-allowed' })))

    expect(server.requests).toHaveLength(0)
    expect(snapshot(chunks).finish).toBe('error')
  })
})

describe('请求编码（Responses body）', () => {
  it('system 走顶层 instructions；system 消息保留自己的角色', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-system'
    harness.principals.bind(fakeAgent(sid), principal({ sid }))
    harness.principals.setLiveness(() => true)

    await collect(harness.ctx.llm.stream({
      ...request({ sessionId: sid }),
      system: '你是助手。',
    }))

    const body = server.requests[0]!.body!
    expect(body.instructions).toBe('你是助手。')
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }])
  })

  it('developer 消息保留 developer 角色（指令语义不被折进 system）；tool-addition 记录被忽略', async () => {
    const cfg = resolveConfig({ baseURL: 'http://127.0.0.1:1/v1', models: ['m'], contextWindow: 1000 }, () => TOKEN)
    const body = encodeRequest(cfg, 'm', {
      stream: true,
      messages: [{
        id: 'm1',
        role: 'developer',
        source: { kind: 'system-prompt' },
        content: [
          { type: 'text', text: '使用工具时保持简洁。' },
          { type: 'tool-addition', toolName: 'search_bible' },
        ],
      } as never],
    })

    expect(body.input).toEqual([{
      role: 'developer',
      content: [{ type: 'input_text', text: '使用工具时保持简洁。' }],
    }])
  })

  it('助手历史：文本 → assistant/output_text，工具调用 → function_call；工具结果 → function_call_output', async () => {
    const cfg = resolveConfig({ baseURL: 'http://127.0.0.1:1/v1', models: ['m'], contextWindow: 1000 }, () => TOKEN)
    const body = encodeRequest(cfg, 'm', {
      stream: true,
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'myrix-gateway', model: 'm' },
          content: [
            { type: 'reasoning', text: '内部推理，不应回放' },
            { type: 'text', text: '我来查一下。' },
            { type: 'tool-call', id: 'call_a', name: 'search_bible', arguments: '{"query":"恩典"}' },
          ],
        } as never,
        {
          id: 't1',
          role: 'tool',
          source: { kind: 'tool', callId: 'call_a' },
          toolCallId: 'call_a',
          content: [{ type: 'text', text: '结果正文' }],
        } as never,
      ],
    })

    expect(body.input).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: '我来查一下。' }] },
      { type: 'function_call', call_id: 'call_a', name: 'search_bible', arguments: '{"query":"恩典"}' },
      { type: 'function_call_output', call_id: 'call_a', output: '结果正文' },
    ])
    // 推理块不回放（无状态 Responses 需要 encrypted_content，我们没有）。
    expect(JSON.stringify(body)).not.toContain('内部推理')
  })

  it('tools 是扁平 function 声明；strict 只在显式开启时发送', async () => {
    const tools = [{ name: 'save_chapter_draft', description: '保存草稿', parameters: { type: 'object', properties: {} } }]
    const plain = encodeRequest(
      resolveConfig({ baseURL: 'http://127.0.0.1:1/v1', models: ['m'], contextWindow: 1000 }, () => TOKEN),
      'm',
      { stream: true, messages: [userMessage('x') as never], tools },
    )
    expect(plain.tools).toEqual([{
      type: 'function',
      name: 'save_chapter_draft',
      description: '保存草稿',
      parameters: { type: 'object', properties: {} },
    }])

    const strict = encodeRequest(
      resolveConfig({ baseURL: 'http://127.0.0.1:1/v1', models: ['m'], contextWindow: 1000, toolStrict: true }, () => TOKEN),
      'm',
      { stream: true, messages: [userMessage('x') as never], tools },
    )
    expect(strict.tools?.[0]).toMatchObject({ type: 'function', name: 'save_chapter_draft', strict: true })
  })

  it('非文本块直接失败，绝不静默降级', () => {
    const cfg = resolveConfig({ baseURL: 'http://127.0.0.1:1/v1', models: ['m'], contextWindow: 1000 }, () => TOKEN)
    expect(() => encodeRequest(cfg, 'm', {
      stream: true,
      messages: [{
        id: 'u1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
      } as never],
    })).toThrow(/只支持纯文本/)
  })
})

describe('流式协议完整性', () => {
  it('文本增量、usage 在 finish 之前、终态 completed → stop', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        created(),
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, '你'),
        textDelta(0, '好'),
        textDone(0, '你好'),
        itemDone(0, messageItem('你好')),
        completed({ usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } }),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    const usageIndex = chunks.findIndex(chunk => chunk.type === 'usage')
    const finishIndex = chunks.findIndex(chunk => chunk.type === 'finish')
    expect(usageIndex).toBeGreaterThanOrEqual(0)
    expect(usageIndex).toBeLessThan(finishIndex)
    expect(snapshot(chunks)).toMatchObject({
      text: '你好',
      finish: 'stop',
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    })
  })

  it('工具调用分片跨事件归并；arguments.done 与 output_item.done 重复完整载荷不重复发出', async () => {
    const full = '{"chapterId":"c1","text":"hi","expectedVersion":1}'
    const server = await gateway(({ response }) => {
      sse(response, [
        created(),
        itemAdded(0, functionCallItem({ callId: 'call_a', name: 'save_chapter_draft', arguments: '' })),
        argsDelta(0, '{"chap'),
        argsDelta(0, 'terId":"c1","text":"hi","expectedVersion":1}'),
        argsDone(0, full),
        itemDone(0, functionCallItem({ callId: 'call_a', name: 'save_chapter_draft', arguments: full })),
        completed({ usage: { input_tokens: 30, output_tokens: 9, total_tokens: 39 } }),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({
      sessionId: sid,
      tools: [{ name: 'save_chapter_draft', description: '保存草稿', parameters: { type: 'object', properties: {} } }],
    })))

    const view = snapshot(chunks)
    expect(view.finish).toBe('tool-calls')
    expect(view.toolCalls).toEqual([{ id: 'call_a', name: 'save_chapter_draft', arguments: full }])
    // 分片总量等于完整载荷：重复的 done 事件没有把参数发两遍。
    const streamed = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> => chunk.type === 'tool-call-delta')
      .map(chunk => chunk.argumentsDelta)
      .join('')
    expect(streamed).toBe(full)
    // block-end 里的权威块也是同一个完整载荷。
    const end = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> =>
      chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(end?.block).toMatchObject({ arguments: full })
  })

  it('只有 done 事件（没有 delta）时也能产出完整工具调用', async () => {
    const full = '{"query":"a"}'
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, functionCallItem({ callId: 'call_1', name: 'search_bible', arguments: '' })),
        argsDone(0, full),
        itemDone(0, functionCallItem({ callId: 'call_1', name: 'search_bible', arguments: full })),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))
    expect(view.toolCalls).toEqual([{ id: 'call_1', name: 'search_bible', arguments: full }])
  })

  it('两个交错工具调用的分片不会互相串台（按 output_index 与 item id 双相关）', async () => {
    const args2 = '{"chapterId":"c2","text":"t"}'
    const args1 = '{"query":"恩典"}'
    const server = await gateway(({ response }) => {
      sse(response, [
        created(),
        itemAdded(0, functionCallItem({ callId: 'call_1', name: 'search_bible', arguments: '', itemId: 'fc_1' })),
        itemAdded(1, functionCallItem({ callId: 'call_2', name: 'save_chapter_draft', arguments: '', itemId: 'fc_2' })),
        argsDelta(1, '{"chapterId"', 'fc_2'),
        argsDelta(0, '{"query"', 'fc_1'),
        argsDelta(1, ':"c2","text":"t"}', 'fc_2'),
        argsDelta(0, ':"恩典"}', 'fc_1'),
        itemDone(1, functionCallItem({ callId: 'call_2', name: 'save_chapter_draft', arguments: args2, itemId: 'fc_2' })),
        itemDone(0, functionCallItem({ callId: 'call_1', name: 'search_bible', arguments: args1, itemId: 'fc_1' })),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))
    const view = snapshot(chunks)

    expect(view.finish).toBe('tool-calls')
    // 分片按到达顺序初现，因此快照顺序按 delta 到达顺序；关键是**每个调用都拿到了
    // 自己的完整参数**，没有串台。
    expect([...view.toolCalls].sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'call_1', name: 'search_bible', arguments: args1 },
      { id: 'call_2', name: 'save_chapter_draft', arguments: args2 },
    ])
    // 权威的块顺序按 output_index 分配：index 0 = call_1，index 1 = call_2。
    const blocks = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
      .sort((left, right) => left.index - right.index)
    expect(blocks.map(chunk => chunk.block)).toEqual([
      { type: 'tool-call', id: 'call_1', name: 'search_bible', arguments: args1 },
      { type: 'tool-call', id: 'call_2', name: 'save_chapter_draft', arguments: args2 },
    ])
  })

  it('reasoning 摘要增量映射成 reasoning 块，且与文本块索引不冲突', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        created(),
        itemAdded(0, { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }),
        reasoningDelta(0, '想一下', 'rs_1'),
        itemDone(0, { id: 'rs_1', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: '想一下' }] }),
        itemAdded(1, { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(1, '答案', 'msg_1'),
        itemDone(1, messageItem('答案', 'msg_1')),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))
    const view = snapshot(chunks)

    expect(view.reasoning).toBe('想一下')
    expect(view.text).toBe('答案')
    const indexes = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }> =>
        chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
      .map(chunk => chunk.index)
    expect(new Set(indexes).size).toBe(2)
  })

  it('usage 只发一次，且按 DSH 互斥口径换算缓存与推理明细', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, 'x'),
        itemDone(0, messageItem('x')),
        completed({
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(chunks.filter(chunk => chunk.type === 'usage')).toHaveLength(1)
    expect(snapshot(chunks).usage).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 40,
      reasoningTokens: 3,
    })
  })

  it('上游缺少 usage → 不产生 usage chunk（DSH 不猜计量）', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, 'x'),
        itemDone(0, messageItem('x')),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(snapshot(chunks).finish).toBe('stop')
  })

  it('SSE event 名承载类型（data 里没有 type）也能解析', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        namedFrame('response.output_item.added', {
          output_index: 0,
          item: { id: 'msg_named', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        }),
        namedFrame('response.output_text.delta', { item_id: 'msg_named', output_index: 0, content_index: 0, delta: '好的' }),
        namedFrame('response.output_item.done', { output_index: 0, item: messageItem('好的', 'msg_named') }),
        namedFrame('response.completed', { response: { id: 'resp_named', status: 'completed', output: [] } }),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))
    expect(view.finish).toBe('stop')
    expect(view.text).toBe('好的')
  })

  it('信息性事件（created / in_progress）被安全忽略', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        created(),
        frame({ type: 'response.in_progress', response: { id: 'resp_fake', status: 'in_progress' } }),
        frame({ type: 'response.content_part.added', item_id: 'msg_fake', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, 'ok'),
        itemDone(0, messageItem('ok')),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    expect(snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid })))).text).toBe('ok')
  })
})

describe('终态与失败分类（绝不从 EOF 推断成功）', () => {
  it('流在终态事件之前结束 → TRANSPORT 失败，不是"正常结束"', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, '半句'),
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.text).toBe('半句')
    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('TRANSPORT')
  })

  it('response.incomplete(max_output_tokens) → max-tokens；其他 incomplete 原因是显式失败', async () => {
    const maxed = await gateway(({ response }) => { sse(response, [incomplete('max_output_tokens'), DONE]) })
    const first = await bootBound(maxed.origin)
    expect(snapshot(await collect(first.harness.ctx.llm.stream(request({ sessionId: first.sid })))).finish)
      .toBe('max-tokens')

    const filtered = await gateway(({ response }) => { sse(response, [incomplete('content_filter'), DONE]) })
    const second = await bootBound(filtered.origin)
    const view = snapshot(await collect(second.harness.ctx.llm.stream(request({ sessionId: second.sid }))))
    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('INVALID_RESPONSE')
  })

  it('response.failed → 显式失败，错误码参与分类', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [failed({ code: 'session_revoked', message: `令牌 ${TOKEN} 已失效` }), DONE])
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))
    const finish = finishOf(chunks)

    expect(finish.reason.kind).toBe('error')
    const failure = 'failure' in finish.reason ? finish.reason.failure : undefined
    expect(failure?.code).toBe('AUTH')
    // 即使上游回显令牌，错误信息里也不会出现它。
    expect(failure?.message).not.toContain(TOKEN)
    expect(failure?.message).toContain('[REDACTED]')
  })

  it('流内 error 事件（session_revoked）→ AUTH 失败', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, '开'),
        errorEvent({ code: 'session_revoked', message: '会话已撤权' }),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))
    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('AUTH')
  })

  it('流内 quota / rate_limit 错误码分类不同', async () => {
    const quota = await gateway(({ response }) => { sse(response, [errorEvent({ code: 'insufficient_quota', message: '额度用尽' }), DONE]) })
    const first = await bootBound(quota.origin)
    expect(snapshot(await collect(first.harness.ctx.llm.stream(request({ sessionId: first.sid })))).failureCode).toBe('QUOTA')

    const limited = await gateway(({ response }) => { sse(response, [errorEvent({ code: 'upstream_rate_limited', message: '限速' }), DONE]) })
    const second = await bootBound(limited.origin)
    expect(snapshot(await collect(second.harness.ctx.llm.stream(request({ sessionId: second.sid })))).failureCode).toBe('RATE_LIMIT')
  })

  it('无法表达的输出类型（如 computer_call）→ UNSUPPORTED_CONTENT，而不是静默丢弃', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, { id: 'cc_1', type: 'computer_call', status: 'completed' }),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))
    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('UNSUPPORTED_CONTENT')
  })

  it('同一 output_index 上内容类型冲突 → INVALID_RESPONSE', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, functionCallItem({ callId: 'call_1', name: 'search_bible', arguments: '' })),
        textDelta(0, '串台了'),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))
    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('INVALID_RESPONSE')
  })

  it('同一 output_index 上 item id 变化 → INVALID_RESPONSE', async () => {
    const server = await gateway(({ response }) => {
      sse(response, [
        itemAdded(0, functionCallItem({ callId: 'call_1', name: 'a', arguments: '', itemId: 'fc_a' })),
        argsDelta(0, '{}', 'fc_b'),
        completed(),
        DONE,
      ])
    })
    const { harness, sid } = await bootBound(server.origin)

    expect(snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid })))).failureCode)
      .toBe('INVALID_RESPONSE')
  })

  it('不是 JSON 的 data 行 → INVALID_RESPONSE', async () => {
    const server = await gateway(({ response }) => {
      sse(response, ['data: not-json\n\n', DONE])
    })
    const { harness, sid } = await bootBound(server.origin)

    expect(snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid })))).failureCode)
      .toBe('INVALID_RESPONSE')
  })
})

describe('HTTP 错误与密钥不外泄', () => {
  it('403 拒绝 → AUTH 失败，错误信息不含 cell 令牌', async () => {
    const server = await gateway(({ response }) => {
      json(response, 403, { error: { message: `token ${TOKEN} not authorized`, type: 'permission_error', code: 'not_authorized' } })
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.ctx.llm.stream(request({ sessionId: sid })))
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    const failure = 'failure' in finish.reason ? finish.reason.failure : undefined
    expect(failure?.code).toBe('AUTH')
    expect(failure?.message).not.toContain(TOKEN)
    expect(failure?.message).toContain('[REDACTED]')
  })

  it('503 缺少上游密钥 → SERVER 失败（不降级、不本地模拟）', async () => {
    const server = await gateway(({ response }) => {
      json(response, 503, { error: { message: '未配置上游密钥', type: 'service_unavailable', code: 'model_not_configured' } })
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('SERVER')
    expect(server.requests).toHaveLength(1)
  })

  it('429 额度耗尽 → QUOTA；纯速率限制 → RATE_LIMIT', async () => {
    const quota = await gateway(({ response }) => {
      json(response, 429, { error: { message: 'insufficient_quota: 额度已用尽', type: 'insufficient_quota', code: 'insufficient_quota' } })
    })
    const first = await bootBound(quota.origin)
    expect(snapshot(await collect(first.harness.ctx.llm.stream(request({ sessionId: first.sid })))).failureCode).toBe('QUOTA')

    const limited = await gateway(({ response }) => {
      json(response, 429, { error: { message: 'rate limit exceeded', type: 'rate_limit_error', code: 'upstream_rate_limited' } })
    })
    const second = await bootBound(limited.origin)
    expect(snapshot(await collect(second.harness.ctx.llm.stream(request({ sessionId: second.sid })))).failureCode).toBe('RATE_LIMIT')
  })

  it('重定向被拒绝：带 cell 令牌的请求不会被转发到另一个 origin', async () => {
    const evil = await gateway(({ response }) => { json(response, 200, { status: 'completed', output: [] }) })
    const redirector = await gateway(({ response }) => {
      response.writeHead(307, { location: evil.url })
      response.end()
    })
    const { harness, sid } = await bootBound(redirector.origin)

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.finish).toBe('error')
    // 重定向目标一个请求都没收到 —— 凭据没有离开原 origin。
    expect(evil.requests).toHaveLength(0)
    expect(redirector.requests).toHaveLength(1)
  })

  it('HTTP 错误路径在归因失败时根本不会触发（先归因，后请求）', async () => {
    const server = await gateway(({ response }) => { json(response, 500, { error: { message: 'boom' } }) })
    const harness = await boot({ baseURL: server.origin })
    harness.principals.setLiveness(() => true)

    await collect(harness.ctx.llm.stream(request({ sessionId: 'sid-none' })))

    expect(server.requests).toHaveLength(0)
  })

  it('端点必须是 https（loopback 例外）：非 loopback 明文 http 启动即失败', async () => {
    await expect(bootHarness({ baseURL: 'http://gateway.example.com/v1' }))
      .rejects.toThrow(/必须是 https/)
  })

  it('指向 chat/completions 或完整 /responses 的 baseURL 启动即失败（不做协议回退）', async () => {
    expect(await rejectionOf(bootHarness({ baseURL: 'https://gw.example.com/v1/chat/completions' })))
      .toContain('chat/completions')
    expect(await rejectionOf(bootHarness({ baseURL: 'https://gw.example.com/v1/responses' })))
      .toContain('网关 origin')
  })

  it('缺令牌 → 启动即失败（不是等到第一次调用）', async () => {
    await expect(bootHarness({ baseURL: 'https://gw.example.com/v1', token: '' }))
      .rejects.toThrow(/cell 服务令牌/)
  })

  it('缺模型清单或上下文容量 → 启动即失败', async () => {
    // 启动失败的判据是"抛错"，不是抛出的具体类型；这里直接比对可读原因，
    // 避免测试对错误对象形状产生依赖。
    const emptyModels = await rejectionOf(bootHarness({
      baseURL: 'https://gw.example.com/v1',
      models: [],
    }))
    expect(emptyModels).toContain('models 为空')

    const noContext = await rejectionOf(bootHarness({
      baseURL: 'https://gw.example.com/v1',
      models: ['myrix-chat'],
      contextWindow: undefined,
    }))
    expect(noContext).toContain('contextWindow 缺失')
  })

  it('baseURL 缺失或非法 → 启动即失败', async () => {
    expect(await rejectionOf(bootHarness({ baseURL: '' }))).toContain('baseURL')
    expect(await rejectionOf(bootHarness({ baseURL: 'not-a-url' }))).toContain('不是合法 URL')
  })
})

describe('取消与超时', () => {
  it('调用方 abort 会真的断开上游连接，终态为 aborted', async () => {
    const server = await gateway(({ response }) => { sseHanging(response, [textDelta(0, '开')]) })
    const { harness, sid } = await bootBound(server.origin)

    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    const iterator = harness.ctx.llm.stream(request({ sessionId: sid, signal: controller.signal }))[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    chunks.push(first.value as StreamChunk)

    controller.abort()
    // 排空剩余（DSH 会把 AbortError 归一成 aborted finish）。
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      chunks.push(next.value)
    }

    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    // 真实 socket 层面的断开：fake 网关观察到连接在响应结束前关闭。
    await expect.poll(() => server.requests[0]?.aborted(), { timeout: 2000 }).toBe(true)
  })

  it('整次请求超时产生 TIMEOUT（不会永远挂住）', async () => {
    const server = await gateway(({ response }) => { sseHanging(response, [textDelta(0, '开')]) })
    const { harness, sid } = await bootBound(server.origin, {
      baseURL: server.origin,
      requestTimeoutMs: 100,
      streamIdleTimeoutMs: 0,
    })

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('TIMEOUT')
  })

  it('空闲看门狗在没有新数据时产生 TIMEOUT，并断开上游', async () => {
    const server = await gateway(({ response }) => {
      sseHanging(response, [
        itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
        textDelta(0, '开'),
      ])
    })
    const { harness, sid } = await bootBound(server.origin, {
      baseURL: server.origin,
      // 整次请求给足时间：这里要验证的是**空闲**看门狗，而不是整次超时。
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 120,
    })

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('TIMEOUT')
    await expect.poll(() => server.requests[0]?.aborted(), { timeout: 2000 }).toBe(true)
  })

  it('流式响应体超过字节上限 → TRANSPORT 失败并停止读取', async () => {
    const server = await gateway(({ response }) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(itemAdded(0, { id: 'msg_fake', type: 'message', status: 'in_progress', role: 'assistant', content: [] }))
      // 一直发大块文本：适配器必须在超过上限时中止，而不是无限缓冲。
      const chunk = textDelta(0, 'x'.repeat(4096))
      const timer = setInterval(() => {
        if (response.writableEnded || response.destroyed) { clearInterval(timer); return }
        response.write(chunk)
      }, 5)
      response.on('close', () => { clearInterval(timer) })
    })
    const { harness, sid } = await bootBound(server.origin, {
      baseURL: server.origin,
      maxResponseBytes: 8 * 1024,
      requestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 0,
    })

    const view = snapshot(await collect(harness.ctx.llm.stream(request({ sessionId: sid }))))

    expect(view.finish).toBe('error')
    expect(view.failureCode).toBe('TRANSPORT')
    await expect.poll(() => server.requests[0]?.aborted(), { timeout: 2000 }).toBe(true)
  })
})

describe('非流式 Responses 路径', () => {
  it('output 数组产出与流式等价的 chunk（文本 + usage + finish）', async () => {
    const server = await gateway(({ response }) => {
      json(response, 200, {
        id: 'resp_fake',
        object: 'response',
        status: 'completed',
        output: [messageItem('非流式答案')],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      })
    })
    const { harness, sid } = await bootBound(server.origin)

    const chunks = await collect(harness.adapter.streamOnce(request({ sessionId: sid })))

    expect(snapshot(chunks)).toMatchObject({
      text: '非流式答案',
      finish: 'stop',
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } satisfies TokenUsage,
    })
    expect(server.requests[0]!.body?.stream).toBe(false)
    expect(server.requests[0]!.body?.store).toBe(false)
    expect(server.requests[0]!.body).not.toHaveProperty('stream_options')
  })

  it('非流式 function_call 也产出工具块并判为 tool-calls', async () => {
    const server = await gateway(({ response }) => {
      json(response, 200, {
        status: 'completed',
        output: [functionCallItem({ callId: 'call_9', name: 'search_bible', arguments: '{"query":"a"}' })],
      })
    })
    const { harness, sid } = await bootBound(server.origin)

    const view = snapshot(await collect(harness.adapter.streamOnce(request({ sessionId: sid }))))
    expect(view.finish).toBe('tool-calls')
    expect(view.toolCalls).toEqual([{ id: 'call_9', name: 'search_bible', arguments: '{"query":"a"}' }])
  })

  it('非流式响应缺少 output 数组 → INVALID_RESPONSE', async () => {
    const server = await gateway(({ response }) => { json(response, 200, { status: 'completed' }) })
    const { harness, sid } = await bootBound(server.origin)

    await expect(collect(harness.adapter.streamOnce(request({ sessionId: sid })))).rejects.toThrow(/output/)
  })

  it('非流式也走归因：无身份时不出请求', async () => {
    const server = await gateway(({ response }) => { json(response, 200, { status: 'completed', output: [] }) })
    const harness = await boot({ baseURL: server.origin })
    harness.principals.setLiveness(() => true)

    await expect(collect(harness.adapter.streamOnce(request({ sessionId: 'sid-x' })))).rejects.toThrow()
    expect(server.requests).toHaveLength(0)
  })
})

describe('模型目录与上下文容量', () => {
  it('resolveModel 给出确切上下文容量（压缩的硬依赖）', async () => {
    const server = await gateway(textScript())
    const harness = await boot({
      baseURL: server.origin,
      models: ['myrix-chat', 'myrix-long'],
      contextWindow: 100_000,
      modelContextWindows: { 'myrix-long': 200_000 },
    })

    const short = await harness.ctx.llm.resolveModelInfo('myrix-gateway', 'myrix-chat')
    const long = await harness.ctx.llm.resolveModelInfo('myrix-gateway', 'myrix-long')

    expect(short.context?.contextWindow).toBe(100_000)
    expect(long.context?.contextWindow).toBe(200_000)
    expect(await harness.ctx.llm.listModels('myrix-gateway')).toEqual([
      { provider: 'myrix-gateway', id: 'myrix-chat', name: 'myrix-chat', inputModalities: ['text'] },
      { provider: 'myrix-gateway', id: 'myrix-long', name: 'myrix-long', inputModalities: ['text'] },
    ])
  })

  it('模型别名只改转发名，不改归因与 DSH 侧模型 id', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin, modelAliases: { 'myrix-chat': 'deepseek-chat' } })
    const sid = 'sid-alias'
    harness.principals.bind(fakeAgent(sid), principal({ sid }))
    harness.principals.setLiveness(() => true)

    await collect(harness.ctx.llm.stream(request({ sessionId: sid })))

    expect(server.requests[0]!.body?.model).toBe('deepseek-chat')
    expect(harness.records[0]).toMatchObject({ model: 'myrix-chat', upstreamModel: 'deepseek-chat' })
  })

  it('文本模型收到的图片由 DSH 投影成占位文本，绝不把图片发给网关', async () => {
    const server = await gateway(textScript())
    const harness = await boot({ baseURL: server.origin })
    const sid = 'sid-image'
    harness.principals.bind(fakeAgent(sid), principal({ sid }))
    harness.principals.setLiveness(() => true)

    const view = snapshot(await collect(harness.ctx.llm.stream({
      ...request({ sessionId: sid }),
      messages: [{
        ...userMessage('看图'),
        content: [{
          type: 'image',
          attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
        }],
      }],
    })))

    // `resolveModel` 声明 inputModalities: ['text']，`LlmRuntime` 据此把图片
    // 投影成确定性占位文本；适配器本体因此只看到文本，网关也不会收到图片字节。
    expect(view.finish).toBe('stop')
    const body = JSON.stringify(server.requests[0]!.body)
    expect(body).toContain('image omitted because this model accepts text only')
    expect(body).not.toContain('image/png')
    expect(body).not.toContain('input_image')
  })
})
