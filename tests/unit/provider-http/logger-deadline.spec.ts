import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import { withTransportSession } from '../../../packages/provider-http/src/transport/session.ts'
import type { HttpTransportRequestInput } from '../../../packages/provider-http/src/transport/session.ts'
import { createHttpProvider } from '../../../packages/provider-http/src/configurable/http-provider.ts'
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'

beforeEach(() => {
  vi.useFakeTimers()
  // Expose otherwise native deadline timers to the deterministic ownership assertions.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function request(overrides: Partial<HttpTransportRequestInput> = {}): HttpTransportRequestInput {
  return {
    displayName: 'Fixture', provider: 'fixture', model: 'gpt-6-luna', path: '/responses',
    accept: 'application/json', body: { value: {}, encoded: '{}', bytes: 2 },
    connection: { baseUrl: 'https://fixture.invalid', headers: {},
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'fixture.retryPolicy'),
      fetch: async () => Response.json({ ok: true }) },
    ...overrides,
  }
}

async function consume(input: HttpTransportRequestInput): Promise<void> {
  for await (const _value of withTransportSession(input, async function* (session) {
    yield await session.response.json()
  })) { /* Consume the shared transport through normal completion. */ }
}

describe('request logger deadline ownership', () => {
  it('omits request observation on a configured provider without a logger', async () => {
    const adapter = createHttpProvider({ displayName: 'Fixture', protocol: openAiResponsesProtocol,
      baseUrl: 'https://fixture.invalid', auth: { kind: 'none' }, models: [{ id: 'gpt-6-luna' }],
      fetch: async () => new Response('data: {"type":"response.completed","response":{}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }),
    })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'fixture', model: 'gpt-6-luna', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(AbortSignal.timeout).not.toHaveBeenCalledWith(5000)
  })

  it.each(['none', 'resolved', 'rejected', 'throwing'] as const)(
    'clears the deadline after a %s observer', async kind => {
      const observeRequest = kind === 'none' ? undefined : () => {
        if (kind === 'throwing') throw new Error('fixture observer failure')
        return kind === 'rejected' ? Promise.reject(new Error('fixture observer failure')) : Promise.resolve()
      }
      await consume(request({ ...(observeRequest === undefined ? {} : { observeRequest }) }))
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('continues after the logger deadline when the observer never settles', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }))
    const input = request({ observeRequest: () => new Promise<void>(() => {}) })
    const pending = consume({ ...input, connection: { ...input.connection, fetch, requestLoggerTimeoutMs: 10 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0.5, 0x1_0000_0000])('skips the observer when its native timeout rejects %s', async milliseconds => {
    vi.mocked(AbortSignal.timeout).mockRestore()
    const observeRequest = vi.fn()
    const input = request({ observeRequest })
    await consume({ ...input, connection: { ...input.connection, requestLoggerTimeoutMs: milliseconds } })
    expect(observeRequest).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the logger deadline on caller abort despite an earlier propagation-stopping listener', async () => {
    const caller = new AbortController()
    caller.signal.addEventListener('abort', event => { event.stopImmediatePropagation() })
    const fetch = vi.fn(async () => Response.json({ ok: true }))
    const input = request({ signal: caller.signal, observeRequest: () => new Promise<void>(() => {}) })
    const pending = consume({ ...input, connection: { ...input.connection, fetch } })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.advanceTimersByTimeAsync(0)
    caller.abort(new Error('fixture cancellation'))
    await rejection
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
