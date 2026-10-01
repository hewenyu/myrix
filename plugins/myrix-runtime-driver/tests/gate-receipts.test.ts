/**
 * 闸门与回执表的测试：每会话串行、drain 单向关闭、重复命令比对。
 */
import { describe, expect, it } from 'vitest'
import { AdmissionGate, GateClosedError } from '../src/gate'
import { ReceiptStore } from '../src/receipts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AdmissionGate 每会话串行', () => {
  it('同一会话的第二个操作在第一个 settle 之前不开始', async () => {
    const gate = new AdmissionGate()
    const first = deferred()
    const order: string[] = []
    const a = gate.run('sid-1', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
    })
    const b = gate.run('sid-1', async () => {
      order.push('b:start')
    })
    // 让微任务跑一轮：b 必须还没开始。
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('不同会话并行执行', async () => {
    const gate = new AdmissionGate()
    const order: string[] = []
    const a = gate.run('sid-a', async () => {
      order.push('a')
    })
    const b = gate.run('sid-b', async () => {
      order.push('b')
    })
    await Promise.all([a, b])
    expect(order.sort()).toEqual(['a', 'b'])
  })

  it('前一条失败不会卡住同一会话的后续命令', async () => {
    const gate = new AdmissionGate()
    const first = gate.run('sid-1', async () => {
      throw new Error('boom')
    })
    await expect(first).rejects.toThrow('boom')
    await expect(gate.run('sid-1', async () => 'ok')).resolves.toBe('ok')
  })

  it('inflight 计数在结算后归零', async () => {
    const gate = new AdmissionGate()
    const pending = gate.run('sid-1', async () => {
      await Promise.resolve()
    })
    expect(gate.inflightCount).toBe(1)
    await pending
    expect(gate.inflightCount).toBe(0)
    expect(gate.activeSessions).toBe(0)
  })
})

describe('AdmissionGate 排空', () => {
  it('closeAndWait 等到在途命令清空才 resolve', async () => {
    const gate = new AdmissionGate()
    const hold = deferred()
    const running = gate.run('sid-1', async () => {
      await hold.promise
    })
    let drained = false
    const waiting = gate.closeAndWait().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    hold.resolve()
    await running
    await waiting
    expect(drained).toBe(true)
  })

  it('排空开始后新命令被拒绝', async () => {
    const gate = new AdmissionGate()
    await gate.closeAndWait()
    await expect(gate.run('sid-1', async () => undefined)).rejects.toBeInstanceOf(GateClosedError)
    expect(gate.accepting).toBe(false)
    expect(gate.draining).toBe(true)
  })

  it('drain 是单向的：closeAndWait 之后不会回到接受的路径', async () => {
    const gate = new AdmissionGate()
    await gate.closeAndWait()
    expect(gate.accepting).toBe(false)
    expect(gate.draining).toBe(true)
  })

  it('重复 closeAndWait 返回同一个 promise（幂等）', async () => {
    const gate = new AdmissionGate()
    const first = gate.closeAndWait()
    const second = gate.closeAndWait()
    expect(first).toBe(second)
  })

  it('空闸门立即排空', async () => {
    const gate = new AdmissionGate()
    await expect(gate.closeAndWait()).resolves.toBeUndefined()
    expect(gate.accepting).toBe(false)
  })

  it('hasPending 反映排队状态', async () => {
    const gate = new AdmissionGate()
    const hold = deferred()
    const running = gate.run('sid-1', async () => {
      await hold.promise
    })
    expect(gate.hasPending('sid-1')).toBe(true)
    expect(gate.hasPending('sid-2')).toBe(false)
    hold.resolve()
    await running
    expect(gate.hasPending('sid-1')).toBe(false)
  })
})

describe('ReceiptStore', () => {
  const record = {
    commandId: 'c1',
    op: 'create',
    sid: 'sid-1',
    bh: 'a'.repeat(64),
    bootId: 'boot-1',
    at: 1,
  }

  it('首次分类返回 undefined（不是重复）', () => {
    const store = new ReceiptStore()
    expect(store.classify(record)).toBeUndefined()
  })

  it('op/sid/bh 全一致才算重试', () => {
    const store = new ReceiptStore()
    store.put(record)
    const verdict = store.classify({ ...record, bh: 'b'.repeat(64) })
    expect(verdict?.kind).toBe('conflict')
  })

  it('op 不同 → 冲突', () => {
    const store = new ReceiptStore()
    store.put(record)
    const verdict = store.classify({ ...record, op: 'resume' })
    expect(verdict?.kind).toBe('conflict')
    if (verdict?.kind === 'conflict') expect(verdict.reason).toContain('op')
  })

  it('sid 不同 → 冲突', () => {
    const store = new ReceiptStore()
    store.put(record)
    const verdict = store.classify({ ...record, sid: 'sid-2' })
    expect(verdict?.kind).toBe('conflict')
    if (verdict?.kind === 'conflict') expect(verdict.reason).toContain('sid')
  })

  it('完全相同 → duplicate 且回执带 note', () => {
    const store = new ReceiptStore()
    store.put(record)
    const verdict = store.classify(record)
    expect(verdict?.kind).toBe('retry')
    if (verdict?.kind === 'retry') {
      expect(verdict.receipt.status).toBe('duplicate')
      expect(verdict.receipt.note).toBeDefined()
    }
  })

  it('超过容量时淘汰最旧记录（有界）', () => {
    const store = new ReceiptStore(2)
    store.put({ ...record, commandId: 'c1' })
    store.put({ ...record, commandId: 'c2' })
    store.put({ ...record, commandId: 'c3' })
    expect(store.size).toBe(2)
    // c1 被淘汰：它的重试会被当成新命令（安全上退化为"再执行一次"，不会放行未授权请求）。
    expect(store.get('c1')).toBeUndefined()
    expect(store.get('c3')).toBeDefined()
  })

  it('容量必须是正整数', () => {
    expect(() => new ReceiptStore(0)).toThrow()
    expect(() => new ReceiptStore(-1)).toThrow()
  })
})
