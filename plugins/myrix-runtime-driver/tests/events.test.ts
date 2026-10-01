/**
 * 事件中枢与 SSE 编码的测试。
 *
 * 重点验证三件事：瞬态帧不带 id、持久帧按 seq 去重、撤权后立刻断开。
 */
import { describe, expect, it, vi } from 'vitest'
import { EventHub } from '../src/events'
import { encodeSseFrame, parseLastEventId, sseSink } from '../src/http'
import type { SseSink } from '../src/http'
import type { StreamEvent } from '../src/types'

/** 记录写入内容的 sink 替身；`sink` 形状与真实实现一致。 */
function recordingSink(): SseSink & { readonly frames: string[]; readonly closed: boolean } {
  const frames: string[] = []
  let closed = false
  return {
    frames,
    get closed() {
      return closed
    },
    get open() {
      return !closed
    },
    write(frame: string) {
      if (closed) return false
      frames.push(frame)
      return true
    },
    close() {
      closed = true
    },
  }
}

function durable(seq: number, type = 'user/message'): StreamEvent {
  return { seq, type, data: { seq }, time: 1000 + seq }
}

function transient(type: string): StreamEvent {
  return { type, data: { delta: 'x' }, time: 2000 }
}

describe('SSE 编码', () => {
  it('持久事件带 id: seq', () => {
    const frame = encodeSseFrame({ seq: 7, type: 'user/message', data: { a: 1 } })
    expect(frame).toContain('id: 7')
    expect(frame).toContain('event: user/message')
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('瞬态事件不带 id', () => {
    const frame = encodeSseFrame({ type: 'myrix/assistant-stream', data: { delta: 'x' } })
    expect(frame).not.toContain('id:')
  })

  it('data 中的换行被转义，帧结构不被破坏', () => {
    const frame = encodeSseFrame({ seq: 1, type: 't', data: { text: 'a\nb' } })
    // 只有 id/event/data 三行 + 一个空行。
    expect(frame.split('\n')).toHaveLength(5)
  })
})

describe('parseLastEventId', () => {
  it('缺失或空串是合法的"未声明"', () => {
    expect(parseLastEventId(undefined)).toEqual({ ok: true, value: undefined })
    expect(parseLastEventId('')).toEqual({ ok: true, value: undefined })
  })

  it('非法值报 400 原因，而不是静默当成"未声明"', () => {
    for (const bad of ['abc', '-1', '1.5', ' 1', '0x10', '+1']) {
      const result = parseLastEventId(bad)
      expect(result.ok).toBe(false)
    }
  })

  it('超出安全整数范围报 400', () => {
    const result = parseLastEventId('99999999999999999999')
    expect(result.ok).toBe(false)
  })

  it('接受非负整数', () => {
    expect(parseLastEventId('0')).toEqual({ ok: true, value: 0 })
    expect(parseLastEventId('42')).toEqual({ ok: true, value: 42 })
  })
})

describe('EventHub 持久事件与去重', () => {
  it('订阅后能收到新事件', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    hub.publishDurable('sid-1', durable(1))
    expect(sink.frames.join('')).toContain('id: 1')
  })

  it('其他会话的事件不会串台', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    hub.publishDurable('sid-2', durable(1))
    expect(sink.frames.join('')).not.toContain('id: 1')
  })

  it('按 Last-Event-ID 补发，且不重复发送已确认的水位', () => {
    const hub = new EventHub()
    hub.publishDurable('sid-1', durable(1))
    hub.publishDurable('sid-1', durable(2))
    hub.publishDurable('sid-1', durable(3))
    const sink = recordingSink()
    hub.subscribe('sid-1', 1, sink, () => true)
    const text = sink.frames.join('')
    expect(text).toContain('id: 2')
    expect(text).toContain('id: 3')
    expect(text).not.toContain('id: 1\n')
  })

  it('重放期间到达的实时事件只发一次（seq 去重）', () => {
    const hub = new EventHub()
    hub.publishDurable('sid-1', durable(1))
    hub.publishDurable('sid-1', durable(2))
    const sink = recordingSink()
    // 在 subscribe 内部的重放阶段注入：用 history provider 触发一次 publish。
    hub.setHistoryProvider((sid) => {
      hub.publishDurable(sid, durable(3))
      return []
    })
    hub.subscribe('sid-1', 1, sink, () => true)
    const text = sink.frames.join('')
    const countOf3 = text.split('id: 3').length - 1
    expect(countOf3).toBe(1)
  })

  it('未声明水位时只发当前水位标记，不重放历史', () => {
    const hub = new EventHub()
    hub.publishDurable('sid-1', durable(1))
    hub.publishDurable('sid-1', durable(2))
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    const text = sink.frames.join('')
    expect(text).toContain('myrix/subscribed')
    expect(text).not.toContain('id: 1')
  })

  it('历史出现空洞时发 myrix/truncated 而不是静默给不连续的流', () => {
    const hub = new EventHub(2)
    hub.publishDurable('sid-1', durable(1))
    hub.publishDurable('sid-1', durable(2))
    hub.publishDurable('sid-1', durable(3))
    const sink = recordingSink()
    hub.subscribe('sid-1', 0, sink, () => true)
    expect(sink.frames.join('')).toContain('myrix/truncated')
  })

  it('history provider 提供的事件优先被采用（权威日志）', () => {
    const hub = new EventHub()
    hub.setHistoryProvider(() => [durable(10), durable(11)])
    const sink = recordingSink()
    hub.subscribe('sid-1', 9, sink, () => true)
    const text = sink.frames.join('')
    expect(text).toContain('id: 10')
    expect(text).toContain('id: 11')
  })

  it('无尽头的 seq 不会被当成持久事件缓冲', () => {
    const hub = new EventHub()
    hub.publishDurable('sid-1', { type: 'x', data: {}, time: 1 })
    expect(hub.stats().sessions).toBe(0)
  })
})

describe('EventHub 瞬态帧', () => {
  it('瞬态帧被转发但不补发、不入缓冲', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    hub.publishTransient('sid-1', transient('myrix/assistant-stream'))
    expect(sink.frames.join('')).toContain('myrix/assistant-stream')
    // 新订阅者看不到它。
    const late = recordingSink()
    hub.subscribe('sid-1', undefined, late, () => true)
    expect(late.frames.join('')).not.toContain('myrix/assistant-stream')
  })

  it('带 seq 的事件不会被当作瞬态帧发出', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    hub.publishTransient('sid-1', durable(5))
    expect(sink.frames.join('')).not.toContain('id: 5')
  })
})

describe('EventHub 撤权检查', () => {
  it('准入返回 false 时立刻关闭连接', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    let admitted = true
    hub.subscribe('sid-1', undefined, sink, () => admitted)
    admitted = false
    hub.publishDurable('sid-1', durable(1))
    expect(sink.closed).toBe(true)
  })

  it('每次发送前都重新检查准入（不是只在订阅时检查一次）', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    const admit = vi.fn(() => true)
    hub.subscribe('sid-1', undefined, sink, admit)
    hub.publishDurable('sid-1', durable(1))
    hub.publishDurable('sid-1', durable(2))
    expect(admit.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('准入抛错按拒绝处理（fail-closed）', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => {
      throw new Error('identity backend down')
    })
    hub.publishDurable('sid-1', durable(1))
    expect(sink.closed).toBe(true)
  })

  it('关闭一个订阅不影响同一会话的另一个订阅', () => {
    const hub = new EventHub()
    const a = recordingSink()
    const b = recordingSink()
    const subA = hub.subscribe('sid-1', undefined, a, () => true)
    hub.subscribe('sid-1', undefined, b, () => true)
    subA.close()
    hub.publishDurable('sid-1', durable(1))
    expect(b.closed).toBe(false)
    expect(b.frames.join('')).toContain('id: 1')
  })

  it('closeSession 关闭该会话全部订阅', () => {
    const hub = new EventHub()
    const a = recordingSink()
    const b = recordingSink()
    hub.subscribe('sid-1', undefined, a, () => true)
    hub.subscribe('sid-1', undefined, b, () => true)
    expect(hub.closeSession('sid-1')).toBe(2)
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
  })

  it('心跳只写在活着的连接上', () => {
    const hub = new EventHub()
    const sink = recordingSink()
    hub.subscribe('sid-1', undefined, sink, () => true)
    hub.heartbeat()
    expect(sink.frames.join('')).toContain(': hb')
  })
})

describe('sseSink', () => {
  /** 可编程的 `ServerResponse` 替身：可控 writableLength 与 destroy 记录。 */
  function fakeResponse(initialBuffered = 0) {
    const chunks: string[] = []
    let destroyed = false
    const res = {
      writableLength: initialBuffered,
      headersSent: false,
      writableEnded: false,
      writeHead(_status: number, _headers: Record<string, unknown>) {
        ;(res as { headersSent: boolean }).headersSent = true
        return res
      },
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
      end() {
        ;(res as { writableEnded: boolean }).writableEnded = true
      },
      destroy() {
        destroyed = true
      },
      on() {},
      removeListener() {},
    }
    return { res, chunks, isDestroyed: () => destroyed }
  }

  it('背压超过上界时断开连接，而不是让 res.write 无限累积', () => {
    const fake = fakeResponse(0)
    const sink = sseSink(fake.res as never, { maxBufferedBytes: 100 })
    // 第一次写入正常。
    expect(sink.write('a'.repeat(10))).toBe(true)
    // 对端不读：缓冲超过上界。
    fake.res.writableLength = 101
    expect(sink.write('b'.repeat(10))).toBe(false)
    expect(fake.isDestroyed()).toBe(true)
    expect(sink.open).toBe(false)
  })

  it('上界之内的写入不受影响', () => {
    const fake = fakeResponse(99)
    const sink = sseSink(fake.res as never, { maxBufferedBytes: 100 })
    expect(sink.write('a')).toBe(true)
    expect(fake.isDestroyed()).toBe(false)
  })

  it('写入响应头并禁止缓冲', () => {
    const headers: Record<string, unknown> = {}
    const chunks: string[] = []
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(_status: number, h: Record<string, unknown>) {
        Object.assign(headers, h)
      },
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
      end() {
        ;(res as { writableEnded: boolean }).writableEnded = true
      },
      on() {},
      removeListener() {},
    }
    const sink = sseSink(res as never)
    expect(headers['content-type']).toContain('text/event-stream')
    expect(headers['cache-control']).toContain('no-store')
    expect(headers['x-accel-buffering']).toBe('no')
    expect(chunks[0]).toContain('retry:')
    sink.close()
    expect(sink.open).toBe(false)
  })
})
