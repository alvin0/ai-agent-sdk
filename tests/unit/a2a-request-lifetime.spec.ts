import { afterEach, expect, it, vi } from 'vitest'
import { A2AAgentLink } from '../../packages/a2a/src/client.ts'
import { endpointFetch } from '../../packages/a2a/src/client/endpoints.ts'
import { createA2AScope } from '../../packages/a2a/src/common/deadline.ts'

afterEach(() => { vi.useRealTimers() })

it('keeps the endpoint deadline until a fragmented response reaches EOF', async () => {
  vi.useFakeTimers()
  let output!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller } })
  const fetch = endpointFetch(async () => new Response(body), { timeoutMs: 100 })
  const response = await fetch('https://fixture.test')
  expect(vi.getTimerCount()).toBe(1)
  const text = response.text()
  output.enqueue(new TextEncoder().encode('local '))
  output.enqueue(new TextEncoder().encode('response'))
  output.close()
  expect(await text).toBe('local response')
  expect(body.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['cancel', 'error', 'timeout'] as const)('releases endpoint ownership on body %s', async mode => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  let output!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller }, cancel })
  const fetch = endpointFetch(async () => new Response(body), { timeoutMs: 10 })
  const response = await fetch('https://fixture.test')
  if (mode === 'cancel') {
    await response.body!.cancel()
    expect(cancel).toHaveBeenCalledOnce()
  } else {
    const reading = expect(response.text()).rejects.toThrow(mode === 'timeout' ? /timeout/ : 'body failed')
    if (mode === 'error') output.error(new Error('body failed'))
    else await vi.advanceTimersByTimeAsync(10)
    await reading
  }
  expect(body.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('releases an endpoint deadline after failed dispatch and an oversized declared body', async () => {
  vi.useFakeTimers()
  const failed = endpointFetch(async () => { throw new Error('dispatch failed') }, { timeoutMs: 100 })
  await expect(failed('https://fixture.test')).rejects.toThrow('dispatch failed')
  expect(vi.getTimerCount()).toBe(0)
  const cancel = vi.fn()
  const oversized = endpointFetch(async () => new Response(new ReadableStream({ cancel }), {
    headers: { 'content-length': '100' },
  }), { timeoutMs: 100, maxTransportBytes: 10 })
  await expect(oversized('https://fixture.test')).rejects.toThrow('10-byte limit')
  expect(cancel).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves parent abort despite earlier listeners and keeps concurrent scope deadlines independent', () => {
  vi.useFakeTimers()
  const caller = new AbortController()
  caller.signal.addEventListener('abort', event => { event.stopImmediatePropagation() })
  const first = createA2AScope(100, caller.signal), second = createA2AScope(100, caller.signal)
  first.dispose()
  expect(vi.getTimerCount()).toBe(1)
  const reason = new Error('caller stopped')
  caller.abort(reason)
  expect(second.signal.reason).toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps cancellation effective after an injected fetch stops propagation on its public signal', async () => {
  vi.useFakeTimers()
  const caller = new AbortController()
  const fetch = endpointFetch(async (_input, init) => {
    init!.signal!.addEventListener('abort', event => { event.stopImmediatePropagation() })
    return new Promise<Response>(() => {})
  }, { timeoutMs: 100 })
  const pending = expect(fetch('https://fixture.test', { signal: caller.signal })).rejects.toThrow('caller stopped')
  caller.abort(new Error('caller stopped'))
  await pending
  expect(vi.getTimerCount()).toBe(0)
})

it('holds the link deadline through streaming teardown and clears it after cancellation', async () => {
  vi.useFakeTimers()
  const caller = new AbortController(), close = vi.fn(async () => ({ done: true as const, value: undefined }))
  const client = {
    sendMessageStream(_request: unknown, options: { signal: AbortSignal }) {
      options.signal.addEventListener('abort', event => { event.stopImmediatePropagation() })
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: close }) }
    },
  }
  const link = new A2AAgentLink(client as never, { agentId: 'fixture', streaming: true, timeoutMs: 100 })
  const pending = expect(link.send({ teamId: 'fixture', messageId: 'message', sender: 'lead', senderAgentId: 'lead',
    content: [{ type: 'text', text: 'local work' }], signal: caller.signal })).rejects.toThrow('caller stopped')
  expect(vi.getTimerCount()).toBe(1)
  caller.abort(new Error('caller stopped'))
  await pending
  expect(close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
