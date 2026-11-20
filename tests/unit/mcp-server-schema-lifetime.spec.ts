import { afterEach, expect, it, vi } from 'vitest'
import { captureInputSchema } from '../../packages/mcp-server/src/server/input-schema.ts'
import { createOperationScope, raceWithSignal } from '../../packages/mcp-server/src/server/advanced-support.ts'
import { callAgent, callRuntimeAgent } from '../../packages/mcp-server/src/server/advanced-calls.ts'
import type { RuntimeAgent } from '@alvin0/ai-agent-sdk-core/agent'

afterEach(() => { vi.useRealTimers() })

it('reuses fresh catalog snapshots only while their owner and schema contents match', async () => {
  const owner = {}
  const first = { type: 'object' as const, properties: { value: { type: 'number' as const } }, required: ['value'] }
  const captured = captureInputSchema(first, owner)
  expect(captureInputSchema(structuredClone(first), owner)).toBe(captured)
  expect(await captured['~standard'].validate({ value: 2 })).toEqual({ value: { value: 2 } })
  const changed = { ...first, properties: { value: { type: 'string' as const } } }
  const revised = captureInputSchema(changed, owner)
  expect(revised).not.toBe(captured)
  expect(await revised['~standard'].validate({ value: 2 })).toHaveProperty('issues')
  expect(await revised['~standard'].validate({ value: 'two' })).toEqual({ value: { value: 'two' } })
  expect(await captured['~standard'].validate({ value: 2 })).toEqual({ value: { value: 2 } })
})

it('captures frozen schemas without allowing validation metadata to modify caller inputs', async () => {
  const properties = Object.freeze({ value: Object.freeze({ type: 'number' as const }) })
  const source = Object.freeze({ type: 'object' as const, properties })
  const captured = captureInputSchema(source)
  expect(await captured['~standard'].validate({ value: 'invalid' })).toHaveProperty('issues')
  expect(source).toEqual({ type: 'object', properties: { value: { type: 'number' } } })
})

it('owns each operation deadline until its invocation releases it', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  const first = createOperationScope(parent.signal, 10)
  const second = createOperationScope(parent.signal, 20)
  first.dispose()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(20)
  expect(first.signal.aborted).toBe(false)
  expect(second.signal.reason).toMatchObject({ name: 'TimeoutError' })
  second.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves parent cancellation and releases its listener when a scope finishes', () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  const scope = createOperationScope(parent.signal, 30_000)
  const removed = vi.spyOn(scope.signal, 'removeEventListener')
  const reason = new Error('caller stopped')
  parent.abort(reason)
  expect(scope.signal.reason).toBe(reason)
  scope.dispose()
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves native parent propagation when a prior listener stops event propagation', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  parent.signal.addEventListener('abort', event => { event.stopImmediatePropagation() })
  const scope = createOperationScope(parent.signal, 30_000)
  scope.signal.addEventListener('abort', event => { event.stopImmediatePropagation() })
  const pending = raceWithSignal(new Promise(() => {}), scope.signal, 10)
  const reason = new Error('caller stopped')
  const rejected = expect(pending).rejects.toBe(reason)
  parent.abort(reason)
  await vi.advanceTimersByTimeAsync(10)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects durations that the previous native timeout could not represent', () => {
  expect(() => createOperationScope(new AbortController().signal, 0x1_0000_0000)).toThrow(RangeError)
})

it('observes an already-started rejection when cancellation wins before the race begins', async () => {
  const parent = new AbortController()
  const reason = new Error('caller stopped')
  parent.abort(reason)
  await expect(raceWithSignal(Promise.reject(new Error('late rejection')), parent.signal, 10)).rejects.toBe(reason)
})

it('bounds teardown of already-started work after cancellation', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  parent.abort(new Error('caller stopped'))
  const pending = raceWithSignal(new Promise(() => {}), parent.signal, 10)
  const rejected = expect(pending).rejects.toThrow('caller stopped')
  await vi.advanceTimersByTimeAsync(10)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('honors cancellation before invoking a runtime agent', async () => {
  const parent = new AbortController()
  parent.abort(new Error('caller stopped'))
  const generate = vi.fn(async () => { throw new Error('must not start') })
  const result = await callRuntimeAgent({ name: 'fixture', version: '1' }, {
    name: 'fixture', agent: { generate } as unknown as RuntimeAgent,
  }, { input: 'local fixture' }, { mcpReq: { id: 1, signal: parent.signal } } as never)
  expect(result.isError).toBe(true)
  expect(generate).not.toHaveBeenCalled()
})

it('keeps cancellation during asynchronous session creation from starting the session', async () => {
  const parent = new AbortController()
  const run = vi.fn(async () => { throw new Error('must not start') })
  const session = { definition: { id: 'agent' }, run }
  const definition = {
    name: 'fixture', agent: { id: 'agent' },
    createSession: async () => {
      queueMicrotask(() => parent.abort(new Error('caller stopped while session was created')))
      return session
    },
  }
  const result = await callAgent({ name: 'fixture', version: '1' }, {
    definition, request: { era: 'modern' },
  } as never, { input: 'local fixture' }, { mcpReq: { id: 1, signal: parent.signal } } as never)
  expect(result.isError).toBe(true)
  expect(run).not.toHaveBeenCalled()
})
