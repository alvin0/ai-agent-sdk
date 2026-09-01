import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import {
  ModelAdapter,
  ModelRegistry,
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  type ObservationEvent,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import { createObservability, type ObservationBatch } from '@ai-agent-sdk/observability'
import {
  FetchObservationExporter,
  flushObservabilityWithWaitUntil,
} from '@ai-agent-sdk/observability-fetch'

type FetchInput = Parameters<typeof fetch>[0]

function observationEvent(sequence = 1): ObservationEvent {
  const scope = createObservationRunScope()
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority: 'critical',
    resource: {
      sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'edge',
    },
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId: 'fetch-run',
      startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data: { status: 'success' },
  }
}

function batch(events: readonly ObservationEvent[] = [observationEvent()]): ObservationBatch {
  return Object.freeze({
    schemaVersion: 1,
    batchId: createOperationId(),
    createdAt: new Date().toISOString(),
    events,
  })
}

function injectedFetch(implementation: (input: FetchInput, init?: RequestInit) => Promise<Response>): typeof fetch {
  return implementation as typeof fetch
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* consume the provider stream */ }
}

describe('Fetch observation exporter', () => {
  it('posts the exact JSON batch with an idempotency key and accepts 204', async () => {
    const calls: Array<{ input: FetchInput; init: RequestInit | undefined }> = []
    const source = batch()
    const exporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test/v1/events',
      headers: { authorization: 'Bearer telemetry-only' },
      fetch: injectedFetch(async (input, init) => {
        calls.push({ input, init })
        return new Response(null, { status: 204 })
      }),
    })

    await expect(exporter.export(source, new AbortController().signal)).resolves.toEqual({
      batchId: source.batchId, accepted: true, retryable: false,
    })
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.input)).toBe('https://telemetry.example.test/v1/events')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify(source) })
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer telemetry-only',
      'content-type': 'application/json',
      'idempotency-key': source.batchId,
    })
  })

  it('requires an exact JSON acknowledgment for non-204 success responses', async () => {
    const source = batch()
    const matching = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test',
      fetch: injectedFetch(async () => Response.json({ acceptedBatchId: source.batchId })),
    })
    const mismatching = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test',
      fetch: injectedFetch(async () => Response.json({ acceptedBatchId: 'another-batch' })),
    })
    const malformed = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test',
      fetch: injectedFetch(async () => new Response('accepted', { status: 200 })),
    })

    await expect(matching.export(source, new AbortController().signal)).resolves.toMatchObject({ accepted: true })
    await expect(mismatching.export(source, new AbortController().signal)).resolves.toEqual({
      batchId: source.batchId, accepted: false, retryable: false,
    })
    await expect(malformed.export(source, new AbortController().signal)).resolves.toMatchObject({
      accepted: false, retryable: false,
    })
  })

  it('retries classified HTTP failures with one immutable body and respects bounded Retry-After', async () => {
    const source = batch()
    const requests: RequestInit[] = []
    const delays: number[] = []
    const responses = [
      new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 204 }),
    ]
    const exporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test',
      random: () => 0.5,
      delay: async milliseconds => { delays.push(milliseconds) },
      fetch: injectedFetch(async (_input, init) => {
        requests.push(init ?? {})
        return responses.shift() ?? new Response(null, { status: 204 })
      }),
    })

    await expect(exporter.export(source, new AbortController().signal)).resolves.toMatchObject({ accepted: true })
    expect(delays).toEqual([60_000, 250])
    expect(requests.map(request => request.body)).toEqual([
      JSON.stringify(source), JSON.stringify(source), JSON.stringify(source),
    ])
    expect(requests.map(request => (request.headers as Record<string, string>)['idempotency-key']))
      .toEqual([source.batchId, source.batchId, source.batchId])
  })

  it('retries network failure up to its attempt limit but does not retry permanent HTTP failure', async () => {
    const source = batch()
    const network = vi.fn(async () => { throw new TypeError('network unavailable') })
    const networkExporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', maxAttempts: 3,
      delay: async () => undefined, fetch: network as typeof fetch,
    })
    await expect(networkExporter.export(source, new AbortController().signal)).resolves.toEqual({
      batchId: source.batchId, accepted: false, retryable: true,
    })
    expect(network).toHaveBeenCalledTimes(3)

    const permanent = vi.fn(async () => new Response(null, { status: 400 }))
    const permanentExporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', fetch: permanent as typeof fetch,
    })
    await expect(permanentExporter.export(source, new AbortController().signal)).resolves.toMatchObject({
      accepted: false, retryable: false,
    })
    expect(permanent).toHaveBeenCalledTimes(1)
  })

  it('bounds request time even when an injected fetch ignores AbortSignal', async () => {
    const source = batch()
    const exporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', requestTimeoutMs: 5, maxAttempts: 1,
      fetch: injectedFetch(async () => await new Promise<Response>(() => undefined)),
    })
    await expect(exporter.export(source, new AbortController().signal)).resolves.toEqual({
      batchId: source.batchId, accepted: false, retryable: true,
    })
  })

  it('propagates host cancellation and does not start another attempt', async () => {
    const source = batch()
    const calls = vi.fn(async () => new Response(null, { status: 503 }))
    const exporter = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', fetch: calls as typeof fetch,
    })
    const controller = new AbortController()
    controller.abort(new DOMException('host stopped', 'AbortError'))
    await expect(exporter.export(source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).not.toHaveBeenCalled()

    const duringBackoff = new AbortController()
    const delayed = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test',
      fetch: injectedFetch(async () => new Response(null, { status: 503 })),
      delay: async () => await new Promise<void>(() => undefined),
    }).export(source, duringBackoff.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    duringBackoff.abort(new DOMException('host stopped during backoff', 'AbortError'))
    await expect(delayed).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('validates endpoint credentials, scheme, loopback exceptions, and managed headers', () => {
    const fetch = injectedFetch(async () => new Response(null, { status: 204 }))
    expect(() => new FetchObservationExporter({ endpoint: 'http://telemetry.example.test', fetch }))
      .toThrow(/must use https/i)
    expect(() => new FetchObservationExporter({ endpoint: 'https://user:secret@example.test', fetch }))
      .toThrow(/credentials/i)
    expect(() => new FetchObservationExporter({
      endpoint: 'https://example.test', headers: { 'content-type': 'text/plain' }, fetch,
    })).toThrow(/managed by the exporter/i)
    expect(() => new FetchObservationExporter({
      endpoint: 'https://example.test', headers: { 'x-observation': 'safe\r\nunsafe' }, fetch,
    })).toThrow(/invalid/i)
    expect(() => new FetchObservationExporter({
      endpoint: 'http://127.0.0.1:8787', allowInsecureHttp: true, fetch,
    })).not.toThrow()
    expect(() => new FetchObservationExporter({
      endpoint: 'http://[::1]:8787', allowInsecureHttp: true, fetch,
    })).not.toThrow()
    expect(() => new FetchObservationExporter({
      endpoint: 'https://example.test', random: 1 as never, fetch,
    })).toThrow(/random must be a function/i)
  })

  it('rejects redirected and cross-origin responses without retrying them', async () => {
    const source = batch()
    for (const property of ['redirected', 'url'] as const) {
      const response = new Response(null, { status: 204 })
      Object.defineProperty(response, property, {
        configurable: true,
        value: property === 'redirected' ? true : 'https://other.example.test/v1/events',
      })
      const fetch = vi.fn(async () => response)
      const exporter = new FetchObservationExporter({
        endpoint: 'https://telemetry.example.test/v1/events', fetch: fetch as typeof globalThis.fetch,
      })
      await expect(exporter.export(source, new AbortController().signal)).resolves.toEqual({
        batchId: source.batchId, accepted: false, retryable: false,
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects batches and acknowledgment bodies beyond configured resource bounds', async () => {
    const source = batch([observationEvent(1), observationEvent(2)])
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const tooMany = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', maxBatchEvents: 1, fetch: fetch as typeof globalThis.fetch,
    })
    await expect(tooMany.export(source, new AbortController().signal)).resolves.toMatchObject({
      accepted: false, retryable: false,
    })
    expect(fetch).not.toHaveBeenCalled()

    const tooLarge = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', maxBatchBytes: 1, fetch: fetch as typeof globalThis.fetch,
    })
    await expect(tooLarge.export(source, new AbortController().signal)).resolves.toMatchObject({ accepted: false })
    expect(fetch).not.toHaveBeenCalled()

    const ackTooLarge = new FetchObservationExporter({
      endpoint: 'https://telemetry.example.test', maxAckBytes: 8,
      fetch: injectedFetch(async () => new Response('0123456789', {
        status: 200, headers: { 'content-length': '10' },
      })),
    })
    await expect(ackTooLarge.export(batch(), new AbortController().signal)).resolves.toMatchObject({
      accepted: false, retryable: false,
    })
  })

  it('attaches exactly one flush promise to an explicit Edge waitUntil hook', async () => {
    let resolveFlush: ((value: { complete: boolean; exportedEvents: number; pendingEvents: number; rejectedCritical: number; timedOut: boolean }) => void) | undefined
    const flushResult = new Promise<{
      complete: boolean; exportedEvents: number; pendingEvents: number; rejectedCritical: number; timedOut: boolean
    }>(resolve => { resolveFlush = resolve })
    const observation = { flush: vi.fn(() => flushResult) }
    const pending: Promise<unknown>[] = []
    const returned = flushObservabilityWithWaitUntil(observation, value => pending.push(value))
    expect(observation.flush).toHaveBeenCalledTimes(1)
    expect(pending).toEqual([returned])
    resolveFlush?.({ complete: true, exportedEvents: 1, pendingEvents: 0, rejectedCritical: 0, timedOut: false })
    await expect(returned).resolves.toMatchObject({ complete: true })
  })

  it('retries observation delivery without replaying the provider dispatch', async () => {
    let providerDispatches = 0
    const requests: Array<{ body: string; idempotencyKey: string | undefined }> = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const idempotencyKey = request.headers['idempotency-key']
      requests.push({ body, idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey })
      response.writeHead(requests.length === 1 ? 503 : 204).end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fake server has no TCP address')
    const exporter = new FetchObservationExporter({
      endpoint: `http://127.0.0.1:${address.port}/v1/events`,
      allowInsecureHttp: true,
      delay: async () => undefined,
    })
    const observation = createObservability({
      mode: 'reliable',
      exporters: [{ exporter, requirement: 'required', boundary: 'remote-acknowledged' }],
    })
    class OneDispatchAdapter extends ModelAdapter {
      stream(): AsyncIterable<StreamChunk> {
        providerDispatches++
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
    const registry = new ModelRegistry({ observation })
    registry.registerAdapter(['fetch-test'], new OneDispatchAdapter())
    const handle = registry.stream({ provider: 'fetch-test', model: 'm', messages: [] })
    try {
      await drain(handle)
      expect((await handle.report).delivery.complete).toBe(true)
      expect(providerDispatches).toBe(1)
      expect(requests.length).toBeGreaterThanOrEqual(2)
      expect(requests[0]?.body).toBe(requests[1]?.body)
      expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
