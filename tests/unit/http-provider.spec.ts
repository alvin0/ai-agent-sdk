/**
 * The acceptance test for provider extensibility.
 *
 * Everything here adds a provider — and even a whole wire protocol — from OUTSIDE
 * the package's own source. Nothing in `src/` is modified, no folder is created,
 * and no build-config entry is added. If a change ever makes that impossible,
 * these tests break.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTextMessage } from '../../src/core/message/message.ts'
import { ModelRegistry } from '../../src/core/runtime/registry.ts'
import type { StreamChunk } from '../../src/core/stream/chunk.ts'
import type { SseEvent } from '../../src/core/stream/sse.ts'
import type { ProviderRequest } from '../../src/providers/base/http-adapter.ts'
import type { ProviderRequestLogRecord } from '../../src/providers/base/http-adapter.ts'
import {
  apiKeyFromEnv,
  createHttpProvider,
  type ModelDiscoveryContext,
} from '../../src/providers/http-provider.ts'
import { openAiResponsesProtocol } from '../../src/providers/protocols/openai-responses.ts'
import { resolveDialect, type WireProtocol } from '../../src/providers/protocols/protocol.ts'
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
