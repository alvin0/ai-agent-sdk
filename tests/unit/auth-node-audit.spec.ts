import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileCodexAuthStore } from '../../packages/auth-node/src/codex-store.ts'
import { fileCopilotAuthStore } from '../../packages/auth-node/src/copilot-store.ts'
import { Http2SessionPool, Http2UnsupportedError } from '../../packages/auth-node/src/http2/pool.ts'
import { createNodeHttp2Fetch } from '../../packages/auth-node/src/http2/fetch.ts'
import { MAX_TIMER_MS } from '@alvin0/ai-agent-sdk-core'
import { withCredentialFileLock } from '../../packages/auth-node/src/common/credential-file.ts'

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:http2', async importOriginal => ({
  ...await importOriginal<typeof import('node:http2')>(), connect,
}))

class SyntheticSession extends EventEmitter {
  destroyed = false
  closed = false
  connecting = true
  remoteSettings = { maxConcurrentStreams: 10 }
  ref() {}
  unref() {}
  destroy() {
    this.destroyed = true
    this.closed = true
    this.emit('close')
  }
  close(callback?: () => void) {
    this.closed = true
    this.emit('close')
    callback?.()
  }
  ready() {
    this.connecting = false
    this.emit('remoteSettings', this.remoteSettings)
    this.emit('connect', this, { alpnProtocol: 'h2' })
  }
}

afterEach(() => { vi.useRealTimers(); connect.mockReset() })

it('cancels a queued credential writer without letting its successor bypass the owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-auth-lock-'))
  const path = join(directory, 'scratch.json')
  let release!: () => void
  let entered!: () => void
  const ownerEntered = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const owner = withCredentialFileLock(path, undefined, async () => {
    order.push('owner')
    entered()
    await gate
  })
  try {
    await ownerEntered
    const controller = new AbortController()
    const reason = new Error('queued credential writer cancelled')
    const cancelledTask = vi.fn(async () => undefined)
    const cancelled = withCredentialFileLock(path, controller.signal, cancelledTask)
    const rejected = expect(cancelled).rejects.toBe(reason)
    const successor = withCredentialFileLock(path, undefined, async () => { order.push('successor') })
    controller.abort(reason)
    await rejected
    expect(order).toEqual(['owner'])
    expect(cancelledTask).not.toHaveBeenCalled()
    release()
    await Promise.all([owner, successor])
    expect(order).toEqual(['owner', 'successor'])
    await withCredentialFileLock(path, undefined, async () => { order.push('reused') })
    expect(order).toEqual(['owner', 'successor', 'reused'])
    expect(await readdir(directory)).toEqual([])
  } finally {
    release()
    await owner
    await rm(directory, { recursive: true, force: true })
  }
})

it('releases the local credential writer queue after a task fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-auth-lock-failure-'))
  const path = join(directory, 'scratch.json')
  try {
    const reason = new Error('scratch writer failed')
    const failed = withCredentialFileLock(path, undefined, async () => { throw reason })
    const rejected = expect(failed).rejects.toBe(reason)
    const next = withCredentialFileLock(path, undefined, async () => 'next writer completed')
    await rejected
    await expect(next).resolves.toBe('next writer completed')
    expect(await readdir(directory)).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('bounds a queued credential writer while its owner remains active', async () => {
  vi.useFakeTimers()
  const directory = await mkdtemp(join(tmpdir(), 'sdk-auth-lock-deadline-'))
  const path = join(directory, 'scratch.json')
  let release!: () => void
  let entered!: () => void
  const ownerEntered = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const owner = withCredentialFileLock(path, undefined, async () => { entered(); await gate })
  try {
    await ownerEntered
    const task = vi.fn(async () => undefined)
    const queued = withCredentialFileLock(path, undefined, task)
    const rejected = expect(queued).rejects.toMatchObject({ code: 'CODEX_CREDENTIAL_LOCK_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30000)
    await rejected
    expect(task).not.toHaveBeenCalled()
    release()
    await owner
    await withCredentialFileLock(path, undefined, async () => undefined)
    expect(vi.getTimerCount()).toBe(0)
    expect(await readdir(directory)).toEqual([])
  } finally {
    release()
    await owner
    await rm(directory, { recursive: true, force: true })
  }
})

describe('auth-node synthetic lifecycle audit', () => {
  it('retains ownership of an active GOAWAY session until explicit close completes', async () => {
    const session = new SyntheticSession()
    let complete!: () => void
    const close = vi.spyOn(session, 'close').mockImplementation(callback => {
      session.closed = true
      complete = () => { session.emit('close'); callback?.() }
    })
    connect.mockReturnValue(session)
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 10, connectTimeoutMs: 1000 })
    const acquiring = pool.acquire('https://synthetic.example.test')
    session.ready()
    const lease = await acquiring
    session.closed = true
    session.emit('goaway')
    const closing = pool.close()
    expect(close).toHaveBeenCalledOnce()
    lease.release()
    complete()
    await closing
    expect(Reflect.get(pool, 'sessions').size).toBe(0)
  })

  it.each([false, true])('keeps explicit close referenced after automatic close %s', async automatic => {
    vi.useFakeTimers()
    const session = new SyntheticSession()
    const ref = vi.spyOn(session, 'ref')
    const unref = vi.spyOn(session, 'unref')
    let complete!: () => void
    const close = vi.spyOn(session, 'close').mockImplementation(callback => {
      session.closed = true
      complete = () => { session.emit('close'); callback?.() }
    })
    connect.mockReturnValue(session)
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 10, connectTimeoutMs: 1000 })
    const acquiring = pool.acquire('https://synthetic.example.test')
    session.ready()
    const lease = await acquiring
    if (automatic) {
      lease.release()
      const before = ref.mock.calls.length
      await vi.advanceTimersByTimeAsync(10)
      expect(ref).toHaveBeenCalledTimes(before)
    }
    let completed = 0
    const first = pool.close().then(() => { completed++ })
    const second = pool.close().then(() => { completed++ })
    const unrefsBefore = unref.mock.calls.length
    lease.unhold()
    expect(unref).toHaveBeenCalledTimes(unrefsBefore)
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    complete()
    await Promise.all([first, second])
    expect(completed).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
    lease.release()
  })

  it('waits for SETTINGS, transfers excess reservations, and preserves caller cancellation', async () => {
    const sessions: SyntheticSession[] = []
    connect.mockImplementation(() => {
      const session = new SyntheticSession()
      session.remoteSettings.maxConcurrentStreams = 2
      sessions.push(session)
      if (sessions.length > 1) queueMicrotask(session.ready.bind(session))
      return session
    })
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 30000, connectTimeoutMs: 1000 })
    const controller = new AbortController()
    const reason = new Error('cancel while SETTINGS is pending')
    const cancelled = pool.acquire('https://synthetic.example.test', controller.signal)
    const rejected = expect(cancelled).rejects.toBe(reason)
    let settled = 0
    const acquiring = Array.from({ length: 4 }, async () => {
      const lease = await pool.acquire('https://synthetic.example.test')
      settled++
      return lease
    })
    const first = sessions[0]!
    first.connecting = false
    first.emit('connect', first, { alpnProtocol: 'h2' })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(0)
    controller.abort(reason)
    await rejected
    first.emit('remoteSettings', first.remoteSettings)
    const leases = await Promise.all(acquiring)
    expect(sessions).toHaveLength(2)
    expect(leases.filter(lease => Object.is(lease.session, first))).toHaveLength(2)
    for (const lease of leases) lease.release()
    await pool.close()
    expect(Reflect.get(pool, 'limits').size).toBe(0)
    expect(first.listenerCount('remoteSettings')).toBe(1)
  })

  it('bounds a connection whose peer never sends usable SETTINGS', async () => {
    vi.useFakeTimers()
    const session = new SyntheticSession()
    session.remoteSettings.maxConcurrentStreams = 0
    connect.mockReturnValue(session)
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 30000, connectTimeoutMs: 1000 })
    const acquiring = pool.acquire('https://synthetic.example.test')
    const rejected = expect(acquiring).rejects.toThrow('closed before connecting')
    session.ready()
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(session.destroyed).toBe(true)
    expect(session.listenerCount('remoteSettings')).toBe(1)
    expect(Reflect.get(pool, 'limits').size).toBe(0)
    expect(Reflect.get(pool, 'sessions').size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pool.close()
  })

  it('releases origin settings and idle timers when the last session closes', async () => {
    vi.useFakeTimers()
    connect.mockImplementation(() => {
      const session = new SyntheticSession()
      queueMicrotask(session.ready.bind(session))
      return session
    })
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 30000, connectTimeoutMs: 1000 })
    for (let index = 0; index < 100; index++) {
      const acquiring = pool.acquire(`https://synthetic-${index}.example.test`)
      await vi.runAllTicks()
      const lease = await acquiring
      lease.release()
      lease.session.destroy()
    }
    expect(Reflect.get(pool, 'limits').size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pool.close()
    expect(Reflect.get(pool, 'limits').size).toBe(0)
  })

  it('closes an idle session immediately when it receives GOAWAY', async () => {
    vi.useFakeTimers()
    const session = new SyntheticSession()
    connect.mockReturnValue(session)
    const pool = new Http2SessionPool({ maxStreamsPerSession: 100, idleTimeoutMs: 30000, connectTimeoutMs: 1000 })
    const acquiring = pool.acquire('https://synthetic.example.test')
    session.ready()
    const lease = await acquiring
    lease.release()
    session.emit('goaway')
    expect(session.closed).toBe(true)
    expect(Reflect.get(pool, 'limits').size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pool.close()
  })

  it('expires fallback origin metadata and clears its timers on close', async () => {
    vi.useFakeTimers()
    connect.mockImplementation(() => { throw new Error('synthetic connection unavailable') })
    const fallback = vi.fn(async () => new Response('fixture'))
    const fetch = createNodeHttp2Fetch({ fallback, fallbackTtlMs: 25 })
    await fetch('https://synthetic.example.test')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(25)
    expect(vi.getTimerCount()).toBe(0)
    await fetch('https://another-synthetic.example.test')
    expect(vi.getTimerCount()).toBe(1)
    await fetch.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves long fallback TTLs across the Node timer limit', async () => {
    vi.useFakeTimers()
    connect.mockImplementation(() => { throw new Http2UnsupportedError('https://synthetic.example.test') })
    const fetch = createNodeHttp2Fetch({
      fallback: async () => new Response('fixture'), fallbackTtlMs: MAX_TIMER_MS + 1,
    })
    await fetch('https://synthetic.example.test')
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS)
    await fetch('https://synthetic.example.test')
    expect(connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
    await fetch('https://synthetic.example.test')
    expect(connect).toHaveBeenCalledTimes(2)
    await fetch.close()
  })

  it('keeps a connection settling after close from starting a fallback request', async () => {
    const session = new SyntheticSession()
    connect.mockReturnValue(session)
    const fallback = vi.fn(async () => new Response('fixture'))
    const fetch = createNodeHttp2Fetch({ fallback })
    const pending = fetch('https://synthetic.example.test').catch((error: unknown) => error)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    await fetch.close()
    expect(await pending).toMatchObject({ cause: { name: 'Http2ClosedError' } })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('keeps credential JSON diagnostics independent of malformed file contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk-auth-audit-'))
    try {
      const path = join(directory, 'synthetic.json')
      await writeFile(path, 'SYNTHETIC_INVALID_JSON_FIXTURE')
      for (const store of [fileCodexAuthStore(path), fileCopilotAuthStore(path)]) {
        const error = await store.read().catch((failure: unknown) => failure)
        expect(error).toMatchObject({ code: 'INVALID_CREDENTIAL' })
        expect((error as Error).cause).toBeUndefined()
        expect((error as Error).message).not.toContain('SYNTHETIC_INVALID_JSON_FIXTURE')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
