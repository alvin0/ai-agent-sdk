/**
 * The acceptance test for provider extensibility.
 *
 * Everything here adds a provider — and even a whole wire protocol — from OUTSIDE
 * the package's own source. Nothing in `src/` is modified, no folder is created,
 * and no build-config entry is added. If a change ever makes that impossible,
 * these tests break.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTextMessage } from '@ai-agent-sdk/core'
import { ModelAdapter, ModelRegistry } from '@ai-agent-sdk/core'
import { createCoreSpan, withRetry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import type { CaptureReceipt, ObservationEvent, ObservationPort } from '@ai-agent-sdk/core'
import {
  createHttpProvider,
  resolveDialect,
  type ModelDiscoveryContext,
  type ProviderRequest,
  type ProviderRequestLogRecord,
  type SseEvent,
  type WireProtocol,
} from '@ai-agent-sdk/provider-http'
import { apiKeyFromEnv } from '../../src/providers/env-credential.ts'
import { openAiResponsesProtocol } from '../../src/providers/protocols/openai-responses.ts'
import type { ResponsesDialect } from '../../src/providers/responses/wire.ts'

/** Build a `Response` whose body streams the given SSE frames. */
function sseResponse(frames: readonly string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

interface Captured {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** Stub `fetch`, recording every request and replying from a queue. */
function stubFetch(replies: readonly (() => Response)[]): Captured[] {
  const captured: Captured[] = []
  let index = 0
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value)
    }
    captured.push({
      url: String(input),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    })
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply === undefined) throw new Error('no scripted reply')
    return Promise.resolve(reply())
  }))
  return captured
}

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

function recordingPort(mode: ObservationPort['mode'] = 'operational') {
  const events: ObservationEvent[] = []
  const port: ObservationPort = {
    mode,
    openSpan: createCoreSpan,
    capture(event) {
      events.push(event)
      return accepted(event)
    },
    checkpoint(event) {
      events.push(event)
      return Promise.resolve({
        eventId: event.eventId,
        status: 'accepted',
        durable: true,
        boundary: 'local-durable',
      })
    },
  }
  return { events, port }
}

/** A minimal Responses stream: one text block, then completion. */
const RESPONSES_OK = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"hi"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"hi"}]}}',
  'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
]

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MY_GATEWAY_KEY
})

describe('createHttpProvider: adding an endpoint with no new code', () => {
  it('serves a compatible gateway from configuration alone', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])

    // This is the whole cost of adding a provider that speaks a known protocol.
    const gateway = createHttpProvider({
      displayName: 'MyGateway',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://gateway.invalid/v1/',
      auth: { kind: 'bearer', token: 'secret-token' },
    })

    const registry = new ModelRegistry()
    registry.registerAdapter(['my-gateway'], gateway)

    const chunks = await drain(registry.stream({
      provider: 'my-gateway',
      model: 'some-model',
      messages: [createTextMessage('hello')],
    }))

    expect(registry.listProviders()).toEqual([{ id: 'my-gateway', name: 'MyGateway' }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const request = captured[0]
    // The trailing slash on baseUrl must not produce a double slash.
    expect(request?.url).toBe('https://gateway.invalid/v1/responses')
    expect(request?.headers.authorization).toBe('Bearer secret-token')
    // Attribution is added by the pipeline, not by the provider config.
    expect(request?.headers['user-agent']).toMatch(/^ai-agent-sdk\//)
    expect(request?.headers.accept).toBe('text/event-stream')
  })

  it('carries a wholly third-party protocol', async () => {
    // Protocols are passed by value, not looked up in a mutable global registry,
    // so a caller can add one this package has never heard of.
    interface MyDialect { readonly greeting: string }

    const myProtocol: WireProtocol<MyDialect> = {
      id: 'my-protocol',
      defaultDialect: { greeting: 'hello' },
      endpointPath: () => '/generate',
      protocolHeaders: () => ({ 'x-my-protocol': '1' }),
      serialize: (request: ProviderRequest, dialect: MyDialect) => ({
        say: dialect.greeting,
        model: request.options.model,
      }),
      async *translate(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
        for await (const event of events) {
          yield { type: 'text-delta', index: 0, text: event.data }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const captured = stubFetch([() => sseResponse(['data: alpha', 'data: beta'])])
    const provider = createHttpProvider({
      displayName: 'Mine',
      protocol: myProtocol,
      baseUrl: 'https://mine.invalid',
      auth: { kind: 'none' },
      dialect: { greeting: 'salut' },
    })

    const chunks = await drain(provider.stream({
      provider: 'mine',
      model: 'm',
      messages: [createTextMessage('x')],
    }))

    expect(captured[0]?.url).toBe('https://mine.invalid/generate')
    expect(captured[0]?.headers['x-my-protocol']).toBe('1')
    expect(captured[0]?.body).toEqual({ say: 'salut', model: 'm' })
    expect(chunks.filter(c => c.type === 'text-delta')).toHaveLength(2)
    expect(captured[0]?.headers.authorization).toBeUndefined()
  })

  it('observes the exact wire request with credentials redacted', async () => {
    const observed: ProviderRequestLogRecord[] = []
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'Logged',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://logged.invalid/v1',
      auth: { kind: 'bearer', token: 'never-log-me' },
      headers: { 'x-debug-label': 'kept', cookie: 'also-secret' },
      requestLogger: record => void observed.push(record),
    })

    await drain(provider.stream({
      provider: 'logged',
      model: 'm',
      messages: [createTextMessage('wire-visible prompt')],
    }))

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      schemaVersion: 1,
      type: 'provider-request',
      provider: 'logged',
      model: 'm',
      method: 'POST',
      url: 'https://logged.invalid/v1/responses',
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        'x-debug-label': 'kept',
      },
    })
    expect(JSON.stringify(observed[0]?.body)).toContain('wire-visible prompt')
    expect(observed[0]?.bodyBytes).toBeGreaterThan(0)
  })

  it('contains request-logger failures instead of blocking provider dispatch', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'BrokenLogger',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://logged.invalid/v1',
      auth: { kind: 'none' },
      requestLogger: () => { throw new Error('disk full') },
    })

    const chunks = await drain(provider.stream({
      provider: 'logged',
      model: 'm',
      messages: [createTextMessage('still dispatch')],
    }))
    expect(captured).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('bounds a request logger that never settles', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'StuckLogger',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://logged.invalid/v1',
      auth: { kind: 'none' },
      requestLoggerTimeoutMs: 10,
      requestLogger: async () => await new Promise<void>(() => {}),
    })
    const started = Date.now()
    const chunks = await drain(provider.stream({
      provider: 'logged', model: 'm', messages: [createTextMessage('still dispatch')],
    }))
    expect(Date.now() - started).toBeLessThan(250)
    expect(captured).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('createHttpProvider: auth schemes', () => {
  it('supports a named header instead of bearer', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'Keyed',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://k.invalid',
      auth: { kind: 'header', name: 'x-api-key', value: 'abc' },
    })
    await drain(provider.stream({
      provider: 'k',
      model: 'm',
      messages: [createTextMessage('x')],
    }))
    expect(captured[0]?.headers['x-api-key']).toBe('abc')
  })

  it('resolves dynamic headers per operation, which is what makes OAuth config-only', async () => {
    const captured = stubFetch([
      () => sseResponse(RESPONSES_OK),
      () => sseResponse(RESPONSES_OK),
    ])
    let issued = 0
    const provider = createHttpProvider({
      displayName: 'Rotating',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://r.invalid',
      auth: {
        kind: 'dynamic',
        resolve: () => {
          issued += 1
          return { authorization: `Bearer token-${issued}` }
        },
      },
    })
    const request = {
      provider: 'r',
      model: 'm',
      messages: [createTextMessage('x')],
    } as const
    await drain(provider.stream({ ...request }))
    await drain(provider.stream({ ...request }))
    // A fresh token per call is what a refreshing credential needs.
    expect(captured[0]?.headers.authorization).toBe('Bearer token-1')
    expect(captured[1]?.headers.authorization).toBe('Bearer token-2')
  })

  it('bounds dynamic credential resolution that ignores cancellation', async () => {
    const captured = stubFetch([])
    const provider = createHttpProvider({
      displayName: 'StuckAuth',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://r.invalid',
      requestTimeoutMs: 10,
      auth: {
        kind: 'dynamic',
        resolve: async () => await new Promise<Record<string, string>>(() => {}),
      },
    })
    const started = Date.now()
    await expect(drain(provider.stream({
      provider: 'r', model: 'm', messages: [createTextMessage('x')],
    }))).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(250)
    expect(captured).toHaveLength(0)
  })

  it('names the environment variable when a credential is missing', () => {
    expect(() => apiKeyFromEnv('MY_GATEWAY_KEY')()).toThrow(/set MY_GATEWAY_KEY/)
    process.env.MY_GATEWAY_KEY = 'from-env'
    expect(apiKeyFromEnv('MY_GATEWAY_KEY')()).toBe('from-env')
  })
})

describe('createHttpProvider: dialect merging', () => {
  it('applies a partial override without erasing other defaults', () => {
    const merged = resolveDialect(openAiResponsesProtocol, { sampling: false })
    expect(merged.sampling).toBe(false)
    // Still present from the protocol's defaults.
    expect(merged.include).toEqual(['reasoning.encrypted_content'])
    expect(merged.store).toBe(false)
  })

  it('ignores undefined entries so an optional override cannot erase a default', () => {
    // `exactOptionalPropertyTypes` already rejects an explicit `undefined` here at
    // compile time, hence the cast. The runtime guard still earns its place: config
    // that arrives from JSON, an env file, or a `cond ? value : undefined` spread
    // carries no such protection.
    const untyped = { reasoningSummary: undefined } as unknown as Partial<ResponsesDialect>
    const merged = resolveDialect(openAiResponsesProtocol, untyped)
    expect(merged.reasoningSummary).toBe('auto')
  })

  it('returns the protocol defaults untouched when nothing is overridden', () => {
    expect(resolveDialect(openAiResponsesProtocol, undefined))
      .toBe(openAiResponsesProtocol.defaultDialect)
  })

  it('lets a dialect knob reach the wire', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'Cached',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://c.invalid',
      auth: { kind: 'none' },
      dialect: { promptCacheKey: 'conversation-7', sampling: false },
    })
    await drain(provider.stream({
      provider: 'c',
      model: 'm',
      messages: [createTextMessage('x')],
      temperature: 0.9,
    }))
    const body = captured[0]?.body as Record<string, unknown>
    expect(body.prompt_cache_key).toBe('conversation-7')
    // `sampling: false` must suppress the caller's temperature.
    expect(body.temperature).toBeUndefined()
  })
})

describe('createHttpProvider: catalog and errors', () => {
  it('feeds a discovered catalog into model resolution and memoizes it', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const discover = vi.fn((_context: ModelDiscoveryContext) => Promise.resolve([
      { id: 'vision-1', inputModalities: ['text', 'image'] as const },
    ]))

    const provider = createHttpProvider({
      displayName: 'Discovered',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://d.invalid',
      auth: { kind: 'none' },
      discoverModels: discover,
    })

    const registry = new ModelRegistry()
    registry.registerAdapter(['d'], provider)

    const models = await registry.listModels('d')
    expect(models[0]?.id).toBe('vision-1')
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])

    await registry.listModels('d')
    // One discovery request serves repeated calls.
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('treats a discovery failure as an empty catalog rather than a failed call', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const provider = createHttpProvider({
      displayName: 'Flaky',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://f.invalid',
      auth: { kind: 'none' },
      discoverModels: () => Promise.reject(new Error('metadata endpoint down')),
    })

    // Refusing the model call because a metadata request failed would be the
    // wrong trade, so the stream must still work.
    const chunks = await drain(provider.stream({
      provider: 'f',
      model: 'm',
      messages: [createTextMessage('x')],
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails discovery closed to an empty catalog when its result exceeds SDK bounds', async () => {
    const provider = createHttpProvider({
      displayName: 'Hostile discovery',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://catalog.invalid',
      auth: { kind: 'none' },
      maxCatalogModels: 2,
      discoverModels: () => Promise.resolve([
        { id: 'one' },
        { id: 'two' },
        { id: 'three' },
      ]),
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['catalog'], provider)

    await expect(registry.listModels('catalog')).resolves.toEqual([])
  })

  it('rejects oversized static catalogs at configuration time', () => {
    expect(() => createHttpProvider({
      displayName: 'Oversized static catalog',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://catalog.invalid',
      auth: { kind: 'none' },
      maxCatalogBytes: 16,
      models: [{ id: 'a-model-id-that-is-too-large' }],
    })).toThrow(/maxCatalogBytes/)
  })

  it('lets an errorCode override fall through by returning undefined', async () => {
    stubFetch([() => new Response('{"detail":"teapot"}', { status: 418 })])
    const provider = createHttpProvider({
      displayName: 'Special',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://s.invalid',
      auth: { kind: 'none' },
      errorCode: (status) => (status === 429 ? 'RATE_LIMIT' : undefined),
    })

    const registry = new ModelRegistry()
    registry.registerAdapter(['s'], provider)
    const chunks = await drain(registry.stream({
      provider: 's',
      model: 'm',
      messages: [createTextMessage('x')],
    }))

    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    // 418 is not the overridden status, so the shared mapping applied.
    expect(finish.reason.failure.code).toBe('HTTP_418')
    expect(finish.reason.failure.message).toBe('teapot')
  })

  it('applies an errorCode override when it returns a code', async () => {
    stubFetch([() => new Response('{"error":{"message":"slow down"}}', { status: 429 })])
    const provider = createHttpProvider({
      displayName: 'Limited',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://l.invalid',
      auth: { kind: 'none' },
      errorCode: (status) => (status === 429 ? 'CUSTOM_THROTTLE' : undefined),
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['l'], provider)
    const chunks = await drain(registry.stream({
      provider: 'l',
      model: 'm',
      messages: [createTextMessage('x')],
    }))
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('CUSTOM_THROTTLE')
  })
})

describe('createHttpProvider: transport resource limits', () => {
  function boundedProvider(overrides: Record<string, unknown>) {
    return createHttpProvider({
      displayName: 'Bounded',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://bounded.invalid',
      auth: { kind: 'none' },
      ...overrides,
    })
  }

  async function throughRegistry(provider: ReturnType<typeof createHttpProvider>) {
    const registry = new ModelRegistry()
    registry.registerAdapter(['bounded'], provider)
    return await drain(registry.stream({
      provider: 'bounded', model: 'm', messages: [createTextMessage('hello')],
    }))
  }

  it('rejects an oversized serialized request before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const chunks = await throughRegistry(boundedProvider({ maxRequestBytes: 16 }))
    const finish = chunks.at(-1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(finish?.type === 'finish' && finish.reason).toMatchObject({
      kind: 'error', failure: { code: 'INVALID_REQUEST' },
    })
  })

  it('bounds cumulative response bytes and raw chunk count', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const byBytes = await throughRegistry(boundedProvider({ maxResponseBytes: 32 }))
    expect(byBytes.at(-1)?.type === 'finish' && byBytes.at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'TRANSPORT' } },
    })

    vi.unstubAllGlobals()
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const byChunks = await throughRegistry(boundedProvider({ maxResponseChunks: 1 }))
    expect(byChunks.at(-1)?.type === 'finish' && byChunks.at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'TRANSPORT' } },
    })
  })

  it('applies an end-to-end request timeout', async () => {
    // Deliberately ignore AbortSignal: the adapter's deadline must still settle
    // the public stream instead of trusting a custom fetch implementation.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const chunks = await throughRegistry(boundedProvider({ requestTimeoutMs: 10 }))
    expect(chunks.at(-1)?.type === 'finish' && chunks.at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'TIMEOUT' } },
    })
  })

  it('reads only a bounded prefix of an HTTP error body', async () => {
    stubFetch([() => new Response(`gateway failure ${'secret-tail'.repeat(1_000)}`, { status: 500 })])
    const chunks = await throughRegistry(boundedProvider({ maxErrorBodyBytes: 32 }))
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('SERVER')
    expect(finish.reason.failure.message).not.toContain('secret-tailsecret-tail')
  })
})

describe('createHttpProvider: physical attempt accounting', () => {
  function observedProvider(overrides: Record<string, unknown> = {}) {
    return createHttpProvider({
      displayName: 'Observed HTTP',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://observed.invalid/v1',
      auth: { kind: 'none' },
      ...overrides,
    })
  }

  function observedRegistry(adapter: ModelAdapter = observedProvider(), observation?: ObservationPort) {
    const registry = new ModelRegistry(observation === undefined ? {} : { observation })
    registry.registerAdapter(['observed-http'], adapter)
    return registry
  }

  const observedRequest = () => ({
    provider: 'observed-http',
    model: 'm',
    messages: [createTextMessage('x')],
  })

  it('reports success, usage, safe origin, status, and provider request ID once per fetch', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK, { headers: { 'request-id': 'req-success' } })])
    const observed = recordingPort()
    const handle = observedRegistry(observedProvider(), observed.port).stream(observedRequest())
    await drain(handle)
    const report = await handle.report

    expect(report).toMatchObject({
      coverage: 'complete',
      reported: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      possiblyBilledAttemptsWithoutUsage: 0,
    })
    expect(report.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: 'success',
        dispatchState: 'sent',
        coverage: 'complete',
        httpStatus: 200,
        providerRequestId: 'req-success',
      }),
    ])
    expect(observed.events.map(event => [event.name, event.phase, event.sequence])).toEqual([
      ['sdk.model.call', 'start', 1],
      ['sdk.provider.attempt', 'start', 2],
      ['sdk.provider.attempt', 'end', 3],
      ['sdk.model.call', 'end', 4],
    ])
    expect(observed.events[1]?.data).toMatchObject({
      origin: 'https://observed.invalid',
      dispatchState: 'not-sent',
    })
    expect(JSON.stringify(observed.events)).not.toContain('/v1/responses')
  })

  it('captures error response IDs and never copies a raw provider body into attempt reports', async () => {
    stubFetch([() => new Response('{"error":{"message":"secret prompt echoed"}}', {
      status: 429,
      headers: { 'x-request-id': 'req-error' },
    })])
    const handle = observedRegistry().stream(observedRequest())
    await drain(handle)
    const report = await handle.report

    expect(report.attempts).toEqual([
      expect.objectContaining({
        status: 'error',
        dispatchState: 'sent',
        coverage: 'missing',
        httpStatus: 429,
        providerRequestId: 'req-error',
        error: expect.objectContaining({ code: 'RATE_LIMIT', status: 429 }),
      }),
    ])
    expect(JSON.stringify(report.attempts)).not.toContain('secret prompt echoed')
    expect(report.possiblyBilledAttemptsWithoutUsage).toBe(1)
  })

  it('keeps a distinct report for every retry under one logical model call', async () => {
    stubFetch([
      () => new Response('{"error":{"message":"busy"}}', { status: 500 }),
      () => sseResponse(RESPONSES_OK),
    ])
    const adapter = withRetry(observedProvider(), {
      policy: {
        mode: 'normal',
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    const observed = recordingPort()
    const handle = observedRegistry(adapter, observed.port).stream(observedRequest())
    await drain(handle)
    const report = await handle.report

    expect(report.attempts.map(attempt => ({
      number: attempt.attemptNumber,
      status: attempt.status,
      dispatch: attempt.dispatchState,
      coverage: attempt.coverage,
    }))).toEqual([
      { number: 1, status: 'error', dispatch: 'sent', coverage: 'missing' },
      { number: 2, status: 'success', dispatch: 'sent', coverage: 'complete' },
    ])
    expect(report.coverage).toBe('partial')
    expect(report.possiblyBilledAttemptsWithoutUsage).toBe(1)
    expect(observed.events.find(event => event.name === 'sdk.provider.retry.scheduled')?.data)
      .toEqual({ nextAttemptNumber: 2, delayMs: 1, failureCode: 'SERVER' })
  })

  it('proves pre-dispatch abort and resource rejection have no physical attempt', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const controller = new AbortController()
    controller.abort(new Error('cancel before dispatch'))
    const aborted = observedRegistry().stream({ ...observedRequest(), signal: controller.signal })
    await drain(aborted)
    expect(await aborted.report).toMatchObject({ coverage: 'not-applicable', attempts: [] })

    const bounded = observedRegistry(observedProvider({ maxRequestBytes: 8 })).stream(observedRequest())
    await drain(bounded)
    expect(await bounded.report).toMatchObject({ coverage: 'not-applicable', attempts: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('classifies credential resolution failure as not applicable before dispatch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const provider = observedProvider({
      auth: {
        kind: 'bearer',
        token: () => { throw new Error('credential store unavailable') },
      },
    })
    const handle = observedRegistry(provider).stream(observedRequest())
    await drain(handle)
    expect(await handle.report).toMatchObject({
      status: 'error',
      coverage: 'not-applicable',
      attempts: [],
      possiblyBilledAttemptsWithoutUsage: 0,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('marks a rejected fetch promise unknown because the remote may have received it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network failed'))))
    const handle = observedRegistry().stream(observedRequest())
    await drain(handle)
    expect((await handle.report).attempts).toEqual([
      expect.objectContaining({ status: 'error', dispatchState: 'unknown', coverage: 'missing' }),
    ])
  })

  it('closes an in-flight attempt as aborted with unknown dispatch state', async () => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const fetchStarted = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => {
      started?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const handle = observedRegistry().stream({ ...observedRequest(), signal: controller.signal })
    const draining = drain(handle)
    await fetchStarted
    controller.abort(new Error('cancel in flight'))
    await draining
    expect((await handle.report).attempts).toEqual([
      expect.objectContaining({ status: 'aborted', dispatchState: 'unknown', coverage: 'missing' }),
    ])
  })

  it('fails audit before fetch when the durable attempt-start checkpoint is unavailable', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const events: ObservationEvent[] = []
    const port: ObservationPort = {
      mode: 'audit',
      openSpan: createCoreSpan,
      capture(event) {
        events.push(event)
        return accepted(event)
      },
      checkpoint(event) {
        events.push(event)
        if (event.name === 'sdk.provider.attempt') {
          return Promise.resolve({
            eventId: event.eventId,
            status: 'rejected',
            durable: false,
            boundary: 'none',
            reason: 'exporter-unavailable',
          })
        }
        return Promise.resolve({
          eventId: event.eventId,
          status: 'accepted',
          durable: true,
          boundary: 'local-durable',
        })
      },
    }
    const handle = observedRegistry(observedProvider(), port).stream(observedRequest())
    await drain(handle)
    const report = await handle.report

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(report).toMatchObject({ coverage: 'not-applicable', attempts: [] })
    expect(report.error?.code).toBe('OBSERVABILITY_AUDIT_UNAVAILABLE')
  })

  it('does not treat memory-only acceptance as an audit durability boundary', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const port: ObservationPort = {
      mode: 'audit',
      openSpan: createCoreSpan,
      capture: accepted,
      checkpoint(event) {
        return Promise.resolve(event.name === 'sdk.provider.attempt'
          ? {
            eventId: event.eventId,
            status: 'accepted' as const,
            durable: false,
            boundary: 'none' as const,
          }
          : {
            eventId: event.eventId,
            status: 'accepted' as const,
            durable: true,
            boundary: 'local-durable' as const,
          })
      },
    }
    const handle = observedRegistry(observedProvider(), port).stream(observedRequest())
    await drain(handle)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await handle.report).toMatchObject({
      coverage: 'not-applicable',
      attempts: [],
      delivery: { complete: false },
      error: { code: 'OBSERVABILITY_AUDIT_UNAVAILABLE' },
    })
  })

  it('does not replay a successful fetch when the audit terminal checkpoint fails', async () => {
    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const events: ObservationEvent[] = []
    const port: ObservationPort = {
      mode: 'audit',
      openSpan: createCoreSpan,
      capture(event) {
        events.push(event)
        return accepted(event)
      },
      checkpoint(event) {
        events.push(event)
        return Promise.resolve(event.name === 'sdk.provider.attempt'
          ? {
            eventId: event.eventId,
            status: 'accepted' as const,
            durable: true,
            boundary: 'local-durable' as const,
          }
          : {
            eventId: event.eventId,
            status: 'rejected' as const,
            durable: false,
            boundary: 'none' as const,
            reason: 'exporter-unavailable' as const,
          })
      },
    }
    const handle = observedRegistry(observedProvider(), port).stream(observedRequest())
    let recovered: Awaited<typeof handle.report> | undefined
    try {
      await drain(handle)
    } catch (error) {
      const candidate = error as { code?: string; report?: Awaited<typeof handle.report> }
      expect(candidate.code).toBe('OBSERVABILITY_AUDIT_UNAVAILABLE')
      recovered = candidate.report
    }
    expect(captured).toHaveLength(1)
    expect(recovered).toBe(await handle.report)
    expect(recovered).toMatchObject({ status: 'success', delivery: { complete: false } })
  })

  it('preserves a successful result when the reliable terminal checkpoint fails', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const port: ObservationPort = {
      mode: 'reliable',
      openSpan: createCoreSpan,
      capture: accepted,
      checkpoint(event) {
        return Promise.resolve({
          eventId: event.eventId,
          status: 'rejected',
          durable: false,
          boundary: 'none',
          reason: 'exporter-unavailable',
        })
      },
    }
    const handle = observedRegistry(observedProvider(), port).stream(observedRequest())
    await expect(drain(handle)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(await handle.report).toMatchObject({ status: 'success', delivery: { complete: false } })
  })

  it('requires explicit opt-in for cleartext HTTP and rejects credentials in URLs', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(sseResponse(RESPONSES_OK)))
    vi.stubGlobal('fetch', fetchSpy)
    const insecure = observedRegistry(observedProvider({ baseUrl: 'http://localhost:8787/v1' }))
      .stream(observedRequest())
    await drain(insecure)
    expect((await insecure.report).attempts).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()

    const allowed = observedRegistry(observedProvider({
      baseUrl: 'http://localhost:8787/v1',
      allowInsecureHttp: true,
    })).stream(observedRequest())
    await drain(allowed)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.mocked(fetchSpy).mockClear()
    const credentialed = observedRegistry(observedProvider({
      baseUrl: 'https://user:pass@observed.invalid/v1',
    })).stream(observedRequest())
    await drain(credentialed)
    expect((await credentialed.report).attempts).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
