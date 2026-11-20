import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolCallId } from '../../packages/core/src/index.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { dispatchToolCall, type ToolInterceptor } from '../../packages/core/src/agent/tool/pipeline.ts'
import { ToolError } from '../../packages/core/src/agent/tool/errors.ts'
import type { ToolDefinition } from '../../packages/core/src/agent/tool/definition.ts'

afterEach(() => { vi.useRealTimers() })

function call(tool: ToolDefinition, signal: AbortSignal, options: {
  defaultTimeoutMs?: number; teardownTimeoutMs?: number; interceptors?: readonly ToolInterceptor[]
} = {}) {
  const catalog = new ToolRegistry()
  catalog.register(tool)
  return dispatchToolCall({ catalog, signal, call: { callId: ToolCallId('deadline'), toolName: 'test',
    rawArguments: '{}' }, position: { turn: 1, step: 1 }, ...options })
}

const definition = { name: 'test', description: 'A local tool.', parameters: { type: 'object' } } as const

it.each(['success', 'fatal'] as const)('disposes long deadlines and parent links after %s', async outcome => {
  vi.useFakeTimers()
  const parent = new AbortController()
  let signal!: AbortSignal
  const failure = ToolError.fatal('tool failed', 'LOCAL_FAILURE')
  const result = call({ ...definition, timeoutMs: 300_000, execute(_args, context) {
    signal = context.signal
    if (outcome === 'fatal') throw failure
    return 'ok'
  } }, parent.signal, { defaultTimeoutMs: 300_000 })
  if (outcome === 'fatal') await expect(result).rejects.toBe(failure)
  else await expect(result).resolves.toMatchObject({ isError: false, value: 'ok' })
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  parent.abort(new Error('parent ended later'))
  expect(signal.reason).toBe(parent.signal.reason)
})

it('keeps the no-timeout path free of owned deadlines', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  await expect(call({ ...definition, execute: () => 'ok' }, parent.signal))
    .resolves.toMatchObject({ isError: false, value: 'ok' })
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
})

it('preserves the native facade TimeoutError and clears the parent listener on timeout', async () => {
  const parent = new AbortController()
  let reason: unknown
  const interceptor: ToolInterceptor = { name: 'wait-for-deadline', around: async context =>
    await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => {
      reason = context.signal.reason
      reject(reason)
    }, { once: true })) }
  await expect(call({ ...definition, execute: () => 'unused' }, parent.signal,
    { defaultTimeoutMs: 5, interceptors: [interceptor] }))
    .resolves.toMatchObject({ isError: true, error: { code: 'TOOL_TIMEOUT' } })
  expect(reason).toBeInstanceOf(DOMException)
  expect(reason).toMatchObject({ name: 'TimeoutError', message: 'The operation was aborted due to timeout', code: 23 })
  expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
})

it('preserves the parent cancellation reason while the tool settles', async () => {
  const parent = new AbortController()
  const reason = new Error('caller cancelled')
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let received: unknown
  const result = call({ ...definition, timeoutMs: 30_000, execute: async (_args, context) => {
    started()
    return await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => {
      received = context.signal.reason
      reject(received)
    }, { once: true }))
  } }, parent.signal, { defaultTimeoutMs: 30_000 })
  await ready
  parent.abort(reason)
  await expect(result).resolves.toMatchObject({ isError: true, error: { code: 'TOOL_ABORTED' } })
  expect(received).toBe(reason)
  expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
})

it.each([undefined, 30_000])('preserves native parent propagation with facade timeout %s', async defaultTimeoutMs => {
  const parent = new AbortController()
  parent.signal.addEventListener('abort', event => event.stopImmediatePropagation())
  const reason = new Error('parent cancellation must propagate')
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let received: unknown
  const result = call({ ...definition, timeoutMs: 30_000, execute: async (_args, context) => {
    started()
    return await new Promise<never>((_resolve, reject) => context.signal.addEventListener('abort', () => {
      received = context.signal.reason
      reject(received)
    }, { once: true }))
  } }, parent.signal, defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs })
  await ready
  parent.abort(reason)
  await expect(result).resolves.toMatchObject({ isError: true, error: { code: 'TOOL_ABORTED' } })
  expect(received).toBe(reason)
})

it('bounds cancellation even when an interceptor suppresses the public signal event', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  const interceptor: ToolInterceptor = { name: 'suppress-public-abort',
    before: async (context, next) => {
      context.signal.addEventListener('abort', event => event.stopImmediatePropagation())
      return await next()
    }, around: async () => await new Promise<never>(() => {}) }
  const result = call({ ...definition, execute: () => 'unused' }, parent.signal,
    { defaultTimeoutMs: 5, teardownTimeoutMs: 5, interceptors: [interceptor] }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(20)
  expect(await result).toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps parent cancellation primary when cleanup outlasts the tool deadline', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  const reason = new Error('caller cancelled before timeout')
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const result = call({ ...definition, timeoutMs: 10, execute: async (_args, context) => {
    started()
    return await new Promise<never>((_resolve, reject) => context.signal.addEventListener('abort', () => {
      setTimeout(() => reject(context.signal.reason), 20)
    }, { once: true }))
  } }, parent.signal, { defaultTimeoutMs: 30_000, teardownTimeoutMs: 50 })
  await ready
  parent.abort(reason)
  await vi.advanceTimersByTimeAsync(30)
  await expect(result).resolves.toMatchObject({ isError: true, error: { code: 'TOOL_ABORTED' } })
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps an uncooperative operation cancelled after bounded teardown', async () => {
  const parent = new AbortController()
  let signal!: AbortSignal
  let release!: () => void
  const pending = new Promise<string>(resolve => { release = () => resolve('late') })
  try {
    await expect(call({ ...definition, execute(_args, context) { signal = context.signal; return pending } },
      parent.signal, { defaultTimeoutMs: 5, teardownTimeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  } finally { release() }
})

it('disposes a longer body deadline when an uncooperative tool outlives its facade deadline', async () => {
  vi.useFakeTimers()
  const parent = new AbortController()
  let release!: () => void
  const pending = new Promise<string>(resolve => { release = () => resolve('late') })
  try {
    const result = call({ ...definition, timeoutMs: 300_000, execute: () => pending }, parent.signal,
      { defaultTimeoutMs: 5, teardownTimeoutMs: 5 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  } finally { release() }
})

it('keeps facade-only deadlines unrefed when no other work keeps Node alive', () => {
  const pipeline = new URL('../../packages/core/src/agent/tool/pipeline.ts', import.meta.url).href
  const registry = new URL('../../packages/core/src/agent/tool/registry.ts', import.meta.url).href
  const source = `
    const { dispatchToolCall } = await import(process.argv[1])
    const { ToolRegistry } = await import(process.argv[2])
    const catalog = new ToolRegistry()
    catalog.register({ name: 'test', description: 'A tool.', parameters: {}, execute: () => 'unused' })
    void dispatchToolCall({ catalog, signal: new AbortController().signal,
      call: { callId: 'unref', toolName: 'test', rawArguments: '{}' }, position: { turn: 1, step: 1 },
      defaultTimeoutMs: 300000, interceptors: [{ name: 'pending', around: () => new Promise(() => {}) }] })
    console.log('started')
  `
  const result = spawnSync(process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', source, pipeline, registry],
    { encoding: 'utf8', timeout: 3_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('started')
})
