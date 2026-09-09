import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform, systemRandomId, UnsupportedRuntimeError } from '../../../packages/core/src/platform/adapter.ts'
import { PLATFORM_LIMITS, UNIVERSAL_FEATURES } from '../../../packages/core/src/platform/config.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createTextMessage } from '../../../packages/core/src/message/message.ts'
import { createSpanId, createTraceId } from '../../../packages/core/src/observation/context.ts'
import { newConversationId } from '../../../packages/core/src/agent/define/session/common.ts'
import { newTeamId, newMessageId } from '../../../packages/core/src/agent/team/common.ts'

function host(): typeof globalThis {
  const input = Object.create(globalThis) as typeof globalThis
  // Node's global accessors require the real global receiver, not a shadow object.
  for (const key of ['crypto', 'performance'] as const) {
    Object.defineProperty(input, key, { configurable: true, value: globalThis[key] })
  }
  return input
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Universal platform preflight', () => {
  it.each(UNIVERSAL_FEATURES)('fails deterministically when %s is unavailable', feature => {
    const input = host()
    if (feature === 'timers') Object.defineProperty(input, 'clearTimeout', { value: undefined })
    else {
      const [root, member] = feature.split('.')
      if (member === undefined) Object.defineProperty(input, root!, { value: undefined })
      else {
        const parent = Object.create(Reflect.get(globalThis, root!) as object) as object
        Object.defineProperty(parent, member, { value: undefined })
        Object.defineProperty(input, root!, { value: parent })
      }
    }
    expect(() => createRuntimePlatform(input)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_RUNTIME', feature }))
  })

  it('does not allocate controllers/timers or invoke codecs, randomness, clocks or cloning during validation', () => {
    const input = host()
    const invoked = vi.fn()
    for (const key of ['AbortController', 'DOMException', 'ReadableStream', 'TextDecoder', 'TextEncoder', 'URL', 'structuredClone', 'setTimeout', 'clearTimeout']) {
      Object.defineProperty(input, key, { value: invoked })
    }
    Object.defineProperty(input, 'AbortSignal', { value: { any: invoked, timeout: invoked } })
    Object.defineProperty(input, 'crypto', { value: { getRandomValues: invoked } })
    Object.defineProperty(input, 'performance', { value: { now: invoked } })
    createRuntimePlatform(input)
    expect(invoked).not.toHaveBeenCalled()
  })

  it('captures function references and original receivers without freezing the host', () => {
    const input = host()
    const crypto = { marker: 7, getRandomValues(data: Uint8Array) { data.fill(this.marker); return data } }
    const clock = { value: 12, now() { return this.value } }
    Object.defineProperty(input, 'crypto', { configurable: true, value: crypto })
    Object.defineProperty(input, 'performance', { configurable: true, value: clock })
    const platform = createRuntimePlatform(input)
    crypto.getRandomValues = () => { throw new Error('changed') }
    clock.now = () => -1
    clock.value = 15
    expect(platform.randomHex(8)).toBe('0707070707070707')
    expect(platform.monotonicNow()).toBe(15)
    expect(Object.isFrozen(crypto)).toBe(false)
    expect(Object.isFrozen(platform)).toBe(true)
  })

  it('contains property and clock exceptions without copying raw details', () => {
    const input = host()
    Object.defineProperty(input, 'crypto', { get() { throw new Error('RAW_PLATFORM/PRIVATE~SENTINEL%') } })
    try { createRuntimePlatform(input); throw new Error('expected failure') } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedRuntimeError)
      expect(String(error)).not.toContain('PRIVATE~SENTINEL%')
      expect((error as Error).cause).toBeUndefined()
    }
    const badClock = host()
    Object.defineProperty(badClock, 'performance', { value: { now: () => Number.NaN } })
    expect(() => createRuntimePlatform(badClock).monotonicNow()).toThrow(UnsupportedRuntimeError)
  })

  it('bounds all-zero random retries and never falls back to Math.random', () => {
    const input = host()
    const fill = vi.fn((values: Uint8Array) => values)
    Object.defineProperty(input, 'crypto', { value: { getRandomValues: fill } })
    expect(() => createRuntimePlatform(input).randomHex(16)).toThrow(UnsupportedRuntimeError)
    expect(fill).toHaveBeenCalledTimes(PLATFORM_LIMITS.randomAttempts)
    vi.stubGlobal('crypto', undefined)
    const random = vi.spyOn(Math, 'random')
    for (const makeId of [systemRandomId, createTraceId, createSpanId, newConversationId, newTeamId, newMessageId,
      () => createTextMessage('hello').id]) expect(makeId).toThrow(UnsupportedRuntimeError)
    expect(random).not.toHaveBeenCalled()
  })

  it('uses Web Crypto for UUIDs and nonzero W3C identifiers without requiring randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues(values: Uint8Array) { values.fill(17); return values } })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const makeId of [systemRandomId, newConversationId, newTeamId, newMessageId]) expect(makeId()).toMatch(uuid)
    expect(createTextMessage('hello').id).toMatch(uuid)
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('runtime-owned timers and cancellation listeners', () => {
  it('disposes deadline timers and both input listeners when an operation settles', () => {
    vi.useFakeTimers()
    const resources = new RuntimeResources(createRuntimePlatform())
    const caller = new AbortController(), root = new AbortController()
    const scope = resources.cancellation([caller.signal, root.signal], 1_000)
    expect(resources.pendingListeners).toBe(2)
    expect(resources.pendingTimers).toBe(1)
    scope.dispose()
    expect(scope.signal.aborted).toBe(false)
    expect(resources.pendingListeners).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    scope.dispose()
    resources.close()
  })

  it.each(['caller', 'deadline', 'owner'] as const)('cancels through %s and clears all owned resources', async mode => {
    vi.useFakeTimers()
    const resources = new RuntimeResources(createRuntimePlatform())
    const caller = new AbortController()
    const scope = resources.cancellation([caller.signal], 10)
    if (mode === 'caller') caller.abort({ secret: 'RAW_ABORT/PRIVATE~SENTINEL%' })
    if (mode === 'deadline') await vi.advanceTimersByTimeAsync(10)
    if (mode === 'owner') resources.close()
    expect(scope.signal.aborted).toBe(true)
    expect(String(scope.signal.reason)).not.toContain('PRIVATE~SENTINEL%')
    expect(resources.pendingListeners).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    resources.close()
  })

  it('handles already-aborted inputs without retaining listeners or allocating a deadline', () => {
    vi.useFakeTimers()
    const resources = new RuntimeResources(createRuntimePlatform())
    const caller = new AbortController()
    caller.abort()
    const scope = resources.cancellation([caller.signal], 1_000)
    expect(scope.signal.aborted).toBe(true)
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    resources.close()
    expect(() => resources.after(1, () => undefined)).toThrow('closed')
  })

  it('bounds native timeout inputs and removes fired timers', async () => {
    vi.useFakeTimers()
    const resources = new RuntimeResources(createRuntimePlatform())
    for (const delay of [-1, Number.NaN, 1.5, PLATFORM_LIMITS.maxTimeoutMs + 1]) {
      expect(() => resources.after(delay, () => undefined)).toThrow(RangeError)
    }
    const callback = vi.fn()
    const cancel = resources.after(0, callback)
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(resources.pendingTimers).toBe(0)
    cancel()
    resources.close()
  })
})
