/**
 * The per-chunk stream read path: event snapshots, byte measuring, abort races
 * and the idle deadline run once per streamed delta, so each is pinned here for
 * the behavior its cheaper implementation must keep.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detachedFrozen } from '../../packages/core/src/primitives/snapshot.ts'
import { utf8ByteLength } from '../../packages/core/src/primitives/utf8.ts'
import { StreamAbortError, StreamAbortRace } from '../../packages/core/src/agent/loop/turn/cancellation.ts'
import { AbortRace } from '../../packages/core/src/stream/abort-race.ts'
import { createStreamIdleDeadline } from '../../packages/provider-http/src/stream/idle-deadline.ts'
import { TextAccumulator } from '../../packages/core/src/stream/text-accumulator.ts'

afterEach(() => { vi.useRealTimers() })

describe('detachedFrozen', () => {
  it('copies plain data deeply, freezes it, and keeps structured-clone semantics', () => {
    const shared = { id: 1 }
    const source: Record<string, unknown> = {
      type: 'text-delta', text: 'hi', index: 0, missing: undefined, negZero: -0, big: 10n,
      trace: { traceId: 't', spans: [shared, shared] },
      [Symbol('hidden')]: 'dropped',
    }
    Object.defineProperty(source, 'secret', { value: 'not enumerable', enumerable: false })
    source.self = source
    const snapshot = detachedFrozen(source)
    expect(snapshot).not.toBe(source)
    expect(snapshot).toEqual(structuredClone(source))
    expect(Object.is(snapshot.negZero, -0)).toBe(true)
    expect('missing' in snapshot).toBe(true)
    expect(Object.getOwnPropertySymbols(snapshot)).toEqual([])
    expect('secret' in snapshot).toBe(false)
    // Cycles and shared references survive as they do through structuredClone.
    expect(snapshot.self).toBe(snapshot)
    const spans = (snapshot.trace as { spans: object[] }).spans
    expect(spans[0]).toBe(spans[1])
    expect(spans[0]).not.toBe(shared)
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.trace) && Object.isFrozen(spans[0])).toBe(true)
    // The source stays live and unfrozen; later mutation does not leak into the snapshot.
    shared.id = 2
    expect(Object.isFrozen(source)).toBe(false)
    expect((spans[0] as { id: number }).id).toBe(1)
  })

  it('returns an existing snapshot as is, and reuses one nested in new data', () => {
    const first = detachedFrozen({ trace: { traceId: 't' } })
    expect(detachedFrozen(first)).toBe(first)
    const wrapped = detachedFrozen({ type: 'usage', trace: first.trace })
    expect(wrapped.trace).toBe(first.trace)
  })

  it('hands non-plain values to structuredClone, including its failures', () => {
    const date = new Date(0)
    const value = detachedFrozen({ at: date, map: new Map([[1, 2]]), holes: [1, , 3] })
    expect(value.at).toBeInstanceOf(Date)
    expect(value.at).not.toBe(date)
    expect(value.map.get(1)).toBe(2)
    expect(1 in value.holes).toBe(false)
    expect(Object.isFrozen(value)).toBe(true)
    expect(() => detachedFrozen({ run: () => undefined })).toThrow()
    expect(() => detachedFrozen(() => undefined)).toThrow()
    expect(detachedFrozen('text')).toBe('text')
  })
})

describe('detachedFrozen edge cases', () => {
  it('keeps an own __proto__ key as data, as structuredClone does, never as a prototype', () => {
    const text = '{"__proto__":{"isAdmin":true},"path":"/tmp"}'
    const args = JSON.parse(text) as Record<string, unknown>
    const snapshot = detachedFrozen({ args }).args as Record<string, unknown>
    expect(Object.keys(snapshot)).toEqual(['__proto__', 'path'])
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(snapshot.isAdmin).toBeUndefined()
    expect(JSON.stringify(snapshot)).toBe(text)
    expect(snapshot).toEqual(structuredClone(args))
  })

  it('copies structured-clone values on every call, since freezing leaves a Date mutable', () => {
    const first = detachedFrozen({ when: new Date(0) })
    const second = detachedFrozen(first)
    expect(second).not.toBe(first)
    second.when.setTime(5)
    expect(first.when.getTime()).toBe(0)
  })
})

describe('utf8ByteLength', () => {
  it('matches TextEncoder for ASCII, multi-byte, astral and lone-surrogate text', () => {
    const encoder = new TextEncoder()
    const samples = ['', 'ok', 'Tiếng Việt', '日本語', '😀 emoji 👍🏽', '\ud800 lone', 'tail \udc00', 'x'.repeat(1000)]
    let seed = 7
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647
    for (let index = 0; index < 200; index++) {
      samples.push(String.fromCharCode(...Array.from({ length: 1 + Math.floor(random() * 40) },
        () => Math.floor(random() * 0x10000))))
    }
    for (const text of samples) expect(utf8ByteLength(text), JSON.stringify(text)).toBe(encoder.encode(text).byteLength)
  })
})

describe('TextAccumulator', () => {
  it('joins every delta in order, across many compactions and interleaved reads', () => {
    const accumulator = new TextAccumulator('seed:')
    let expected = 'seed:'
    for (let index = 0; index < 2_000; index++) {
      const delta = index % 7 === 0 ? '' : `${index}é😀,`
      accumulator.append(delta)
      expected += delta
      if (index % 333 === 0) expect(accumulator.text).toBe(expected)
      expect(accumulator.length).toBe(expected.length)
    }
    expect(accumulator.text).toBe(expected)
    expect(accumulator.text).toBe(expected)
    expect(new TextAccumulator().text).toBe('')
    expect(new TextAccumulator().length).toBe(0)
  })
})

describe('AbortRace', () => {
  it('registers one listener for a whole loop and removes it on dispose', async () => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal])
    const add = vi.spyOn(signal, 'addEventListener')
    const remove = vi.spyOn(signal, 'removeEventListener')
    const race = new AbortRace(signal)
    for (let index = 0; index < 50; index++) expect(await race.next(Promise.resolve(index))).toBe(index)
    race.dispose()
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects the pending read on abort, and every later read', async () => {
    const controller = new AbortController()
    const race = new StreamAbortRace(controller.signal)
    const never = new Promise<number>(() => undefined)
    const pending = race.next(never)
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBeInstanceOf(StreamAbortError)
    await expect(pending).rejects.toMatchObject({ cause: reason })
    // A late rejection of the source is observed, not left unhandled.
    await expect(race.next(Promise.reject(new Error('late')))).rejects.toBeInstanceOf(StreamAbortError)
    race.dispose()
  })

  it('rejects with the signal reason by default', async () => {
    const controller = new AbortController()
    const race = new AbortRace(controller.signal)
    const pending = race.next(new Promise<number>(() => undefined))
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    race.dispose()
  })

  it('passes the source failure through when it loses to no abort', async () => {
    const race = new AbortRace(new AbortController().signal)
    const failure = new Error('adapter failed')
    await expect(race.next(Promise.reject(failure))).rejects.toBe(failure)
    race.dispose()
  })
})

describe('createStreamIdleDeadline', () => {
  async function* ticks(count: number, everyMs: number, activity: () => void) {
    for (let index = 0; index < count; index++) {
      await new Promise(resolve => setTimeout(resolve, everyMs))
      activity()
      yield index
    }
  }

  it('stays alive while activity keeps arriving, longer than the timeout in total', async () => {
    vi.useFakeTimers()
    const deadline = createStreamIdleDeadline(10, 'Fixture', 1_000)
    const seen: number[] = []
    const run = (async () => { for await (const value of deadline.guard(ticks(20, 6, deadline.activity))) seen.push(value) })()
    await vi.advanceTimersByTimeAsync(200)
    await run
    expect(seen).toHaveLength(20)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a pending read once the stream goes idle', async () => {
    vi.useFakeTimers()
    const deadline = createStreamIdleDeadline(10, 'Fixture', 1_000)
    async function* stalls() { yield 1; await new Promise(() => undefined) }
    const iterator = deadline.guard(stalls())
    expect((await iterator.next()).value).toBe(1)
    const pending = iterator.next()
    const assertion = expect(pending).rejects.toThrow('Fixture stream idle for more than 10ms')
    // The stalled source ignores return(), so the failure surfaces once teardown is bounded.
    await vi.advanceTimersByTimeAsync(11 + 1_000)
    await assertion
  })

  it('re-checks a timeout beyond the timer range rarely instead of spinning', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const deadline = createStreamIdleDeadline(3e9, 'Fixture', 1_000)
    async function* slow() { await new Promise(resolve => setTimeout(resolve, 50)); yield 1 }
    const values: number[] = []
    for await (const value of deadline.guard(slow())) values.push(value)
    const calls = timers.mock.calls.length
    timers.mockRestore()
    expect(values).toEqual([1])
    // One deadline timer and the source's own; an overflowing delay fires every 1 ms.
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('fails the next read when the deadline passed between reads', async () => {
    vi.useFakeTimers()
    const deadline = createStreamIdleDeadline(10, 'Fixture', 1_000)
    async function* source() { yield 1; yield 2 }
    const iterator = deadline.guard(source())
    expect((await iterator.next()).value).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    await expect(iterator.next()).rejects.toThrow('idle for more than 10ms')
  })
})
