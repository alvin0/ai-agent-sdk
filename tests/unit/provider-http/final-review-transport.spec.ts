import { describe, expect, it, vi } from 'vitest'
import { createRuntimeHttpProvider, defineWireProtocol } from '../../../packages/provider-http/src/index.ts'
import type { ModelInvocationContext } from '@ai-agent-sdk/core'

const protocol = defineWireProtocol({
  id: 'ownership-test', defaultDialect: {}, endpointPath: () => '/stream', serialize: () => ({}),
  async *translate(events) {
    for await (const _event of events) yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  },
})
function provider(fetch: typeof globalThis.fetch, requestLogger?: () => void) {
  return createRuntimeHttpProvider({ displayName: 'Ownership test', protocol,
    baseUrl: 'https://ownership.invalid', auth: { kind: 'none' }, fetch,
    ...(requestLogger === undefined ? {} : { requestLogger }) })
}
const request = { provider: 'test', model: 'test', messages: [] }
async function drain(source: AsyncIterable<unknown>) { for await (const _chunk of source) { /* drain */ } }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('final review HTTP ownership', () => {
  it.each(['reject', 'hang'] as const)('bounds an unread response cancellation that will %s', async outcome => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => outcome === 'reject'
      ? Promise.reject(new Error('cancel failed')) : new Promise<void>(() => undefined))
    try {
      const running = drain(provider(async () => new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/json' },
      })).stream(request))
      const outcome = running.then(() => undefined, error => error)
      await vi.advanceTimersByTimeAsync(30_001)
      expect(await outcome).toMatchObject({ code: 'HTTP_STREAM_MEDIA_TYPE_INVALID' })
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('contains synchronous fetch failure and retains unknown dispatch evidence', async () => {
    const end = vi.fn()
    const context = { startProviderAttempt: async () => ({ end }) } as unknown as ModelInvocationContext
    const fetch = vi.fn(() => { throw new Error('sync fetch failure') })
    await expect(drain(provider(fetch).stream(request, context))).rejects.toBeDefined()
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', dispatchState: 'unknown' }))
  })

  it('cancels a custom response body while its parser is waiting on an abort-ignoring read', async () => {
    const caller = new AbortController(), entered = deferred<void>(), cancel = vi.fn()
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller },
      pull() { entered.resolve() }, cancel,
    })
    const running = drain(provider(async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    })).stream({ ...request, signal: caller.signal }))
    void running.catch(() => undefined)
    await entered.promise
    // Allow parser ownership to be acquired before aborting.
    await new Promise(resolve => setTimeout(resolve, 0))
    caller.abort()
    try { await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), { timeout: 100 }) }
    finally {
      try { bodyController.error(new Error('test cleanup')) } catch { /* already cancelled */ }
      await running.catch(() => undefined)
    }
  })

  it.each(['resolve', 'reject'] as const)('owns late fetch %s after public cancellation', async outcome => {
    const entered = deferred<void>(), raw = deferred<Response>(), caller = new AbortController()
    const fetch = vi.fn(async () => { entered.resolve(); return raw.promise })
    const cancel = vi.fn()
    const running = drain(provider(fetch).stream({ ...request, signal: caller.signal }))
    void running.catch(() => undefined)
    await entered.promise
    caller.abort()
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    if (outcome === 'resolve') {
      raw.resolve(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }))
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    } else {
      raw.reject(new Error('late rejection'))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  it.each([
    { 'content-type': 'application/json' },
    { 'content-type': 'text/event-stream', 'content-length': '999999999' },
  ])('cancels an unread response on header rejection: %j', async headers => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers }))
    await expect(drain(provider(fetch).stream(request))).rejects.toBeDefined()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['logger', 'admission'] as const)('does not dispatch after abort inside %s', async boundary => {
    const caller = new AbortController(), fetch = vi.fn(async () => new Response())
    const end = vi.fn()
    const adapter = provider(fetch, boundary === 'logger' ? () => caller.abort() : undefined)
    const context = boundary === 'admission' ? {
      startProviderAttempt: async () => { caller.abort(); return { end } },
    } as unknown as ModelInvocationContext : undefined
    await expect(drain(adapter.stream({ ...request, signal: caller.signal }, context))).rejects.toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
    if (boundary === 'admission') expect(end).toHaveBeenCalledWith(expect.objectContaining({ dispatchState: 'not-sent' }))
  })
})
