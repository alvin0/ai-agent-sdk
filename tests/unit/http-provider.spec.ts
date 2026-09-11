/**
 * The acceptance test for provider extensibility.
 *
 * Everything here adds a provider — and even a whole wire protocol — from OUTSIDE
 * the package's own source. Nothing in `src/` is modified, no folder is created,
 * and no build-config entry is added. If a change ever makes that impossible,
 * these tests break.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { ModelAdapter, ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, OBSERVATION_ERROR_CODES, createCoreSpan, withRetry } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { CaptureReceipt, ObservationEvent, ObservationPort } from '@alvin0/ai-agent-sdk-core'
import {
  HTTP_PROTOCOL_API_VERSION,
  HTTP_PROVIDER_ERROR_CODES,
  createHttpProvider,
  createRuntimeHttpProvider,
  defineWireProtocol,
  resolveDialect,
  type ModelDiscoveryContext,
  type ProviderRequest,
  type ProviderRequestLogRecord,
  type SseEvent,
  type WireProtocol,
} from '@alvin0/ai-agent-sdk-provider-http'
import { apiKeyFromEnv } from '@alvin0/ai-agent-sdk-auth-node/env'
import {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import { ForeignModelError } from './fixtures/foreign-model-error.ts'

/** Build a `Response` whose body streams the given SSE frames. */
function sseResponse(frames: readonly string[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'text/event-stream')
  return new Response(body, { status: 200, ...init, headers })
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

describe('defineWireProtocol', () => {
  it('creates an inert frozen v1 wrapper with detached dialect and captured methods', () => {
    const dialect = { version: 'v1', nested: { enabled: true } }
    const definition = {
      id: 'custom-runtime-protocol',
      defaultDialect: dialect,
      endpointPath: () => '/first',
      serialize: () => ({ ok: true }),
      async *translate() {
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    }

    const protocol = defineWireProtocol(definition)
    definition.endpointPath = () => '/replaced'
    dialect.version = 'mutated'
    dialect.nested.enabled = false

    expect(protocol).toMatchObject({
      kind: 'http-wire-protocol',
      apiVersion: HTTP_PROTOCOL_API_VERSION,
      id: 'custom-runtime-protocol',
    })
    expect(Object.isFrozen(protocol)).toBe(true)
    expect(Object.isFrozen(protocol.defaultDialect)).toBe(true)
    expect(Object.isFrozen(protocol.defaultDialect.nested)).toBe(true)
    expect(protocol.defaultDialect).toEqual({ version: 'v1', nested: { enabled: true } })
    expect(protocol.endpointPath({} as never, protocol.defaultDialect)).toBe('/first')
  })

  it('rejects accessor-backed and async-shaped definitions without invoking getters', () => {
    const getter = vi.fn(() => 'unsafe')
    const accessor = {
      defaultDialect: {},
      endpointPath: () => '/generate',
      serialize: () => ({}),
      async *translate() {},
    }
    Object.defineProperty(accessor, 'id', { enumerable: true, get: getter })
    expect(() => defineWireProtocol(accessor as never)).toThrow(/accessor/i)
    expect(getter).not.toHaveBeenCalled()

    expect(() => defineWireProtocol({
      id: 'missing-method',
      defaultDialect: {},
      endpointPath: () => '/generate',
      serialize: () => ({}),
      translate: undefined,
    } as never)).toThrow(/translate/i)
  })
})

describe('createRuntimeHttpProvider', () => {
  function runtimeProtocol() {
    return defineWireProtocol({
      id: 'runtime-test',
      defaultDialect: { suffix: '!' },
      endpointPath: () => '/generate',
      serialize: request => ({ model: request.model.id }),
      async *translate(events, _request, _displayName) {
        for await (const event of events) {
          yield { type: 'text-delta' as const, index: 0, text: event.data }
        }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    })
  }

  it('is inert and resolves a versioned credential only when a request starts', async () => {
    const resolve = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted()
      return 'runtime-secret'
    })
    const credential = defineCredentialSource({ id: 'runtime-key', resolve })
    let authorization: string | null = null
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization')
      return Promise.resolve(sseResponse(['data: hello']))
    })
    const provider = createRuntimeHttpProvider({
      displayName: 'Runtime Provider',
      protocol: runtimeProtocol(),
      baseUrl: new URL('https://runtime.invalid/v1'),
      auth: { kind: 'bearer', token: credential },
      fetch,
    })

    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await drain(provider.stream({
      provider: 'runtime-route', model: 'runtime-model', messages: [createTextMessage('hello')],
    }))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(authorization).toBe('Bearer runtime-secret')
  })

  it('rotates header credentials and dynamic endpoint headers per logical operation', async () => {
    let credentialGeneration = 0
    let headerGeneration = 0
    const credential = defineCredentialSource({
      id: 'rotating-header-key',
      resolve: () => `secret-${++credentialGeneration}`,
    })
    const received: Array<{ key: string | null; operation: string | null }> = []
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      received.push({ key: headers.get('x-api-key'), operation: headers.get('x-operation') })
      return Promise.resolve(sseResponse(['data: hello']))
    })
    const provider = createRuntimeHttpProvider({
      displayName: 'Rotating Header Provider',
      protocol: runtimeProtocol(),
      baseUrl: 'https://rotating.invalid',
      auth: { kind: 'header', name: 'x-api-key', value: credential },
      headers: () => ({ 'x-operation': `operation-${++headerGeneration}` }),
      retryPolicy: { mode: 'normal', maxRetries: 2 },
      fetch,
    })

    expect(credentialGeneration).toBe(0)
    expect(headerGeneration).toBe(0)
    await drain(provider.stream({ provider: 'rotating', model: 'm', messages: [] }))
    await drain(provider.stream({ provider: 'rotating', model: 'm', messages: [] }))
    expect(received).toEqual([
      { key: 'secret-1', operation: 'operation-1' },
      { key: 'secret-2', operation: 'operation-2' },
    ])
    expect(provider.providerRetryPolicy('rotating')).toMatchObject({ mode: 'normal', maxRetries: 2 })
  })

  it('passes exact route/base context to dynamic auth and discovery', async () => {
    const auth = vi.fn(() => ({ 'x-signature': 'signed' }))
    const discover = vi.fn(() => Promise.resolve([{ id: 'discovered' }]))
    const provider = createRuntimeHttpProvider({
      displayName: 'Context Provider',
      protocol: runtimeProtocol(),
      baseUrl: 'https://context.invalid/v1',
      auth: { kind: 'dynamic', resolve: auth },
      discoverModels: discover,
      fetch: () => Promise.resolve(sseResponse(['data: hello'])),
    })

    await provider.listModels('context-route')
    expect(auth).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'context-route',
      baseUrl: new URL('https://context.invalid/v1'),
      signal: expect.any(AbortSignal),
    }))
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'context-route',
      baseUrl: new URL('https://context.invalid/v1'),
      signal: expect.any(AbortSignal),
    }))
  })

  it('rejects an incompatible marker before protocol methods or fetch are accessed', () => {
    const endpointPath = vi.fn(() => '/generate')
    const fetch = vi.fn()
    expect(() => createRuntimeHttpProvider({
      displayName: 'Invalid Runtime Provider',
      protocol: {
        ...runtimeProtocol(),
        apiVersion: 2,
        endpointPath,
      } as never,
      baseUrl: 'https://invalid.example',
      auth: { kind: 'none' },
      fetch,
    })).toThrow(expect.objectContaining({
      code: HTTP_PROVIDER_ERROR_CODES.PROTOCOL_API_UNSUPPORTED,
    }))
    expect(endpointPath).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('captures callback references and detaches static options during construction', async () => {
    const transportHeaders = {
      'x-static-option': 'first',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    }
    const endpointHeaders = vi.fn(() => ({ 'x-dynamic-option': 'first' }))
    const replacedHeaders = vi.fn(() => ({ 'x-dynamic-option': 'replaced' }))
    const firstLogger = vi.fn()
    const replacedLogger = vi.fn()
    const firstFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const sent = new Headers(init?.headers)
      expect(sent.get('x-dynamic-option')).toBe('first')
      expect(sent.get('x-static-option')).toBe('first')
      return Promise.resolve(new Response('{"error":{"message":"expected"}}', { status: 418 }))
    })
    const replacedFetch = vi.fn(() => Promise.reject(new Error('replacement must not run')))
    const firstErrorCode = vi.fn(() => 'CAPTURED_HTTP_ERROR')
    const replacedErrorCode = vi.fn(() => 'REPLACED_HTTP_ERROR')
    const options = {
      displayName: 'Captured Runtime Provider',
      protocol: runtimeProtocol(),
      baseUrl: 'https://captured.invalid/v1',
      auth: { kind: 'none' as const },
      headers: endpointHeaders,
      baseHeaders: transportHeaders,
      fetch: firstFetch,
      requestLogger: firstLogger,
      errorCode: firstErrorCode,
    }
    const provider = createRuntimeHttpProvider(options)
    transportHeaders['x-static-option'] = 'mutated'
    options.headers = replacedHeaders
    options.fetch = replacedFetch
    options.requestLogger = replacedLogger
    options.errorCode = replacedErrorCode

    await expect(drain(provider.stream({
      provider: 'captured', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: 'CAPTURED_HTTP_ERROR' })
    expect(endpointHeaders).toHaveBeenCalledTimes(1)
    expect(replacedHeaders).not.toHaveBeenCalled()
    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(replacedFetch).not.toHaveBeenCalled()
    expect(firstLogger).toHaveBeenCalledTimes(1)
    expect(replacedLogger).not.toHaveBeenCalled()
    expect(firstErrorCode).toHaveBeenCalledTimes(1)
    expect(replacedErrorCode).not.toHaveBeenCalled()
  })

  it('rejects accessor-backed callback options without invoking their getters', () => {
    const fetchGetter = vi.fn(() => globalThis.fetch)
    const options = {
      displayName: 'Accessor Runtime Provider',
      protocol: runtimeProtocol(),
      baseUrl: 'https://accessor.invalid/v1',
      auth: { kind: 'none' as const },
    }
    Object.defineProperty(options, 'fetch', { enumerable: true, get: fetchGetter })
    expect(() => createRuntimeHttpProvider(options)).toThrow(/accessor/i)
    expect(fetchGetter).not.toHaveBeenCalled()
  })

  it.each([
    ['root primitive', 1],
    ['promise', Promise.resolve({ ok: true })],
    ['function', () => undefined],
    ['bigint', { value: 1n }],
    ['non-finite', { value: Number.NaN }],
    ['unsupported prototype', new Date(0)],
    ['circular graph', (() => { const value: Record<string, unknown> = {}; value.self = value; return value })()],
    ['depth overflow', (() => {
      const value: Record<string, unknown> = {}
      let cursor = value
      for (let index = 0; index < 66; index++) {
        const next: Record<string, unknown> = {}
        cursor.next = next
        cursor = next
      }
      return value
    })()],
    ['member overflow', { values: Array(100_001).fill(null) }],
  ])('rejects %s serializer output before dispatch', async (_name, value) => {
    const fetch = vi.fn()
    const protocol = defineWireProtocol({
      id: 'invalid-body',
      defaultDialect: {},
      endpointPath: () => '/generate',
      serialize: () => value as never,
      async *translate() {},
    })
    const provider = createRuntimeHttpProvider({
      displayName: 'Invalid Body',
      protocol,
      baseUrl: 'https://invalid-body.example',
      auth: { kind: 'none' },
      fetch,
    })

    await expect(drain(provider.stream({
      provider: 'invalid-body', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_INVALID })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects accessor-backed serializer output without invoking the getter', async () => {
    const getter = vi.fn(() => 'private-value')
    const value = { stable: true } as Record<string, unknown>
    Object.defineProperty(value, 'secret', { enumerable: true, get: getter })
    const fetch = vi.fn()
    const provider = createRuntimeHttpProvider({
      displayName: 'Accessor Body',
      protocol: defineWireProtocol({ id: 'accessor-body', defaultDialect: {},
        endpointPath: () => '/generate', serialize: () => value, async *translate() {} }),
      baseUrl: 'https://accessor-body.example', auth: { kind: 'none' }, fetch,
    })
    await expect(drain(provider.stream({ provider: 'accessor', model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_INVALID })
    expect(getter).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('detaches the synchronous serializer result before later mutation', async () => {
    const bodies: unknown[] = []
    const provider = createRuntimeHttpProvider({
      displayName: 'Detached Body',
      protocol: defineWireProtocol({ id: 'detached-body', defaultDialect: {},
        endpointPath: () => '/generate', serialize: () => {
          const value = { stable: 'before' }
          queueMicrotask(() => { value.stable = 'after' })
          return value
        }, async *translate(events) {
          for await (const _event of events) { /* drain */ }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        } }),
      baseUrl: 'https://detached-body.example', auth: { kind: 'none' },
      fetch: (_input, init) => {
        bodies.push(init?.body)
        return Promise.resolve(sseResponse(['data: done']))
      },
    })
    await drain(provider.stream({ provider: 'detached', model: 'm', messages: [] }))
    await Promise.resolve()
    expect(bodies).toEqual(['{"stable":"before"}'])
  })

  it('classifies encoded wire-body overflow before fetch or provider-attempt admission', async () => {
    const fetch = vi.fn()
    const startProviderAttempt = vi.fn()
    const provider = createRuntimeHttpProvider({
      displayName: 'Bounded Body',
      protocol: defineWireProtocol({ id: 'bounded-body', defaultDialect: {},
        endpointPath: () => '/generate', serialize: () => ({ value: 'too-large' }),
        async *translate() {} }),
      baseUrl: 'https://bounded-body.example', auth: { kind: 'none' }, fetch,
      maxRequestBytes: 8,
    })
    await expect(drain(provider.stream(
      { provider: 'bounded-body', model: 'm', messages: [] },
      { startProviderAttempt: startProviderAttempt as never },
    ))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_TOO_LARGE })
    expect(startProviderAttempt).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serializes and encodes once per prepared logical call across physical retry', async () => {
    const serialize = vi.fn(() => ({ stable: 'body' }))
    const protocol = defineWireProtocol({
      id: 'retry-body',
      defaultDialect: {},
      endpointPath: () => '/generate',
      serialize,
      async *translate(events) {
        for await (const event of events) {
          if (event.data === '[DONE]') break
        }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    })
    const bodies: unknown[] = []
    let attempt = 0
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body)
      attempt++
      return Promise.resolve(attempt === 1
        ? new Response('{"error":{"message":"busy"}}', { status: 500 })
        : sseResponse(['data: [DONE]']))
    })
    const adapter = withRetry(createRuntimeHttpProvider({
      displayName: 'Retry Body',
      protocol,
      baseUrl: 'https://retry-body.example',
      auth: { kind: 'none' },
      fetch,
    }), {
      policy: {
        mode: 'normal',
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['retry-body'], adapter)

    await drain(registry.stream({
      provider: 'retry-body', model: 'm', messages: [createTextMessage('hello')],
    }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(bodies).toEqual(['{"stable":"body"}', '{"stable":"body"}'])
  })

  it('reuses one endpoint/auth snapshot through retry and rotates it for the next logical call', async () => {
    let credentialGeneration = 0
    let endpointGeneration = 0
    let physicalAttempt = 0
    const discoveryHeaders: Readonly<Record<string, string>>[] = []
    const dispatchHeaders: RequestInit['headers'][] = []
    const credential = defineCredentialSource({
      id: 'prepared-retry-key',
      resolve: () => `secret-${++credentialGeneration}`,
    })
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      dispatchHeaders.push(init?.headers)
      physicalAttempt++
      return Promise.resolve(physicalAttempt === 1
        ? new Response('{"error":{"message":"busy"}}', { status: 500 })
        : sseResponse(['data: hello']))
    })
    const adapter = withRetry(createRuntimeHttpProvider({
      displayName: 'Prepared Header Snapshot',
      protocol: runtimeProtocol(),
      baseUrl: 'https://prepared-headers.example',
      auth: { kind: 'header', name: 'x-custom-proof', value: credential },
      headers: () => ({ 'x-operation-generation': `operation-${++endpointGeneration}` }),
      discoverModels: ({ headers }) => {
        discoveryHeaders.push(headers)
        return Promise.resolve([{ id: 'm' }])
      },
      fetch,
    }), {
      policy: {
        mode: 'normal', maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['prepared-headers'], adapter)
    const request = { provider: 'prepared-headers', model: 'm', messages: [] } as const

    await drain(registry.stream({ ...request }))
    await drain(registry.stream({ ...request }))

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(credentialGeneration).toBe(2)
    expect(endpointGeneration).toBe(2)
    expect(discoveryHeaders).toHaveLength(1)
    expect(dispatchHeaders[0]).toEqual(discoveryHeaders[0])
    expect(dispatchHeaders[0]).toBe(dispatchHeaders[1])
    expect(dispatchHeaders[2]).not.toBe(dispatchHeaders[0])
    expect(dispatchHeaders.map(headers => new Headers(headers).get('x-custom-proof'))).toEqual([
      'secret-1', 'secret-1', 'secret-2',
    ])
    expect(dispatchHeaders.map(headers => new Headers(headers).get('x-operation-generation'))).toEqual([
      'operation-1', 'operation-1', 'operation-2',
    ])
  })
})

describe('createHttpProvider: adding an endpoint with no new code', () => {
  function throwingProtocol(error: unknown): WireProtocol<Record<string, never>> {
    return {
      id: 'throwing-protocol',
      defaultDialect: {},
      endpointPath: () => '/generate',
      serialize: () => ({}),
      async *translate() {
        throw error
      },
    }
  }

  it('preserves a bounded structurally compatible foreign ModelError envelope', async () => {
    const provider = createHttpProvider({
      displayName: 'Foreign Failure',
      protocol: throwingProtocol(new ForeignModelError('retry later', 'RATE_LIMIT', {
        status: 429,
        providerRetryAfterMs: 250,
        requestId: 'foreign-request-1',
      })),
      baseUrl: 'https://foreign.invalid/v1',
      auth: { kind: 'none' },
      fetch: () => Promise.resolve(sseResponse(['data: ignored'])),
    })

    await expect(drain(provider.stream({
      provider: 'foreign', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      failure: {
        message: 'retry later',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 250,
        requestId: 'foreign-request-1',
      },
    })
  })

  it('downgrades malformed and accessor-backed foreign failure envelopes to UNKNOWN', async () => {
    const outerGetter = vi.fn(() => 'RATE_LIMIT')
    const innerGetter = vi.fn(() => 'RATE_LIMIT')
    const accessorOuter = new Error('accessor outer') as Error & { failure: object }
    Object.defineProperty(accessorOuter, 'code', { get: outerGetter })
    accessorOuter.failure = { message: 'busy', code: 'RATE_LIMIT' }
    const accessorInner = Object.assign(new Error('accessor inner'), { code: 'RATE_LIMIT' })
    const innerFailure = { message: 'busy' }
    Object.defineProperty(innerFailure, 'code', { get: innerGetter })
    Object.defineProperty(accessorInner, 'failure', { value: innerFailure })
    const mismatch = Object.assign(new Error('mismatch'), {
      code: 'RATE_LIMIT',
      failure: { message: 'mismatch', code: 'AUTH' },
    })
    const loneCode = Object.assign(new Error('lone code'), { code: 'RATE_LIMIT' })

    for (const error of [accessorOuter, accessorInner, mismatch, loneCode]) {
      const provider = createHttpProvider({
        displayName: 'Invalid Foreign Failure',
        protocol: throwingProtocol(error),
        baseUrl: 'https://foreign.invalid/v1',
        auth: { kind: 'none' },
        fetch: () => Promise.resolve(sseResponse(['data: ignored'])),
      })
      await expect(drain(provider.stream({
        provider: 'foreign', model: 'm', messages: [createTextMessage('hello')],
      }))).rejects.toMatchObject({ code: 'UNKNOWN', failure: { code: 'UNKNOWN' } })
    }
    expect(outerGetter).not.toHaveBeenCalled()
    expect(innerGetter).not.toHaveBeenCalled()
  })

  it('uses an injected fetch implementation instead of the platform global', async () => {
    const platformFetch = vi.fn(() => Promise.reject(new Error('platform fetch must stay unused')))
    const injectedFetch = vi.fn(() => Promise.resolve(sseResponse(RESPONSES_OK)))
    vi.stubGlobal('fetch', platformFetch)
    const provider = createHttpProvider({
      displayName: 'Injected',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://injected.invalid/v1',
      auth: { kind: 'none' },
      fetch: injectedFetch,
    })

    await drain(provider.stream({
      provider: 'injected',
      model: 'm',
      messages: [createTextMessage('hello')],
    }))

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    expect(platformFetch).not.toHaveBeenCalled()
  })

  it('rejects non-SSE success responses and bounded event overflow with stable codes', async () => {
    const nonSse = vi.fn(() => Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const invalidMedia = createHttpProvider({
      displayName: 'MediaBound',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://media.invalid/v1',
      auth: { kind: 'none' },
      fetch: nonSse,
    })
    await expect(drain(invalidMedia.stream({
      provider: 'media', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID })

    const tooMany = createHttpProvider({
      displayName: 'EventBound',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://events.invalid/v1',
      auth: { kind: 'none' },
      fetch: () => Promise.resolve(sseResponse(['data: {}', 'data: {}'])),
      maxSseEvents: 1,
    })
    await expect(drain(tooMany.stream({
      provider: 'events', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.SSE_LIMIT_EXCEEDED })
  })

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
      auth: {
        kind: 'dynamic',
        resolve: () => ({ authorization: 'Bearer never-log-me', cookie: 'also-secret' }),
      },
      headers: { 'x-debug-label': 'kept' },
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

  it('rejects cross-layer, case-variant, reserved, and static credential headers', async () => {
    const cases = [
      { headers: { Accept: 'application/json' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION },
      { headers: { 'User-Agent': 'spoofed' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION },
      { headers: { Host: 'other.example' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_RESERVED },
      { headers: { 'X-AI-Agent-SDK-Trace': 'spoofed' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_RESERVED },
      { headers: { 'X-Api-Key': 'static-secret' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_RESERVED },
      { headers: { 'ChatGPT-Account-Id': 'static-account' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_RESERVED },
      { headers: { 'X-Invalid': 'line\r\nbreak' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_INVALID },
      { headers: { 'X-Duplicate': 'first', 'x-duplicate': 'second' }, code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION },
    ] as const
    for (const entry of cases) {
      const fetch = vi.fn()
      const provider = createHttpProvider({
        displayName: 'Header Policy',
        protocol: openAiResponsesProtocol,
        baseUrl: 'https://headers.invalid/v1',
        auth: { kind: 'none' },
        headers: entry.headers,
        fetch,
      })
      await expect(drain(provider.stream({
        provider: 'headers', model: 'm', messages: [createTextMessage('hello')],
      }))).rejects.toMatchObject({ code: entry.code })
      expect(fetch).not.toHaveBeenCalled()
    }

    const collisionFetch = vi.fn()
    const collision = createHttpProvider({
      displayName: 'Header Collision',
      protocol: {
        ...openAiResponsesProtocol,
        protocolHeaders: () => ({ 'X-Custom': 'protocol' }),
      },
      baseUrl: 'https://headers.invalid/v1',
      auth: { kind: 'none' },
      headers: { 'x-custom': 'endpoint' },
      fetch: collisionFetch,
    })
    await expect(drain(collision.stream({
      provider: 'headers', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION })
    expect(collisionFetch).not.toHaveBeenCalled()
  })

  it('reports non-auth layer collisions before resolving credentials', async () => {
    const resolve = vi.fn(() => ({ 'x-auth-proof': 'private' }))
    const fetch = vi.fn()
    const provider = createHttpProvider({
      displayName: 'Collision Ordering',
      protocol: {
        ...openAiResponsesProtocol,
        protocolHeaders: () => ({ 'X-Shared': 'protocol' }),
      },
      baseUrl: 'https://headers.invalid/v1',
      auth: { kind: 'dynamic', resolve },
      headers: { 'x-shared': 'endpoint' },
      fetch,
    })

    await expect(drain(provider.stream({
      provider: 'headers', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION })
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects endpoint/auth collisions case-insensitively before dispatch', async () => {
    const fetch = vi.fn()
    const provider = createHttpProvider({
      displayName: 'Auth Collision',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://headers.invalid/v1',
      auth: { kind: 'dynamic', resolve: () => ({ 'X-Custom-Proof': 'private' }) },
      headers: { 'x-custom-proof': 'static' },
      fetch,
    })

    await expect(drain(provider.stream({
      provider: 'headers', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redacts every dynamic-auth header by provenance, including custom signatures', async () => {
    const observed: ProviderRequestLogRecord[] = []
    const provider = createHttpProvider({
      displayName: 'Signed',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://signed.invalid/v1',
      auth: { kind: 'dynamic', resolve: () => ({ 'x-custom-proof': 'private-proof' }) },
      fetch: () => Promise.resolve(sseResponse(RESPONSES_OK)),
      requestLogger: record => { observed.push(record) },
    })
    await drain(provider.stream({
      provider: 'signed', model: 'm', messages: [createTextMessage('hello')],
    }))
    expect(observed[0]?.headers['x-custom-proof']).toBe('[REDACTED]')
    expect(JSON.stringify(observed)).not.toContain('private-proof')
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
  it('keeps explicit metadata independent from credentialed discovery, empty discovery, and failure', async () => {
    const resolve = vi.fn(() => 'private-static-key')
    const discover = vi.fn(() => Promise.reject(new Error('must not discover static metadata')))
    const fetch = vi.fn<typeof globalThis.fetch>()
    const high = ReasoningEffortId('high')
    const provider = createRuntimeHttpProvider({
      displayName: 'Static metadata',
      protocol: defineWireProtocol({ id: 'static-metadata', defaultDialect: {},
        endpointPath: () => '/generate', serialize: () => ({}), async *translate() {} }),
      baseUrl: 'https://metadata.invalid',
      auth: { kind: 'bearer', token: defineCredentialSource({ id: 'static-key', resolve }) },
      models: [{
        id: 'declared-model', contextWindow: 64_000, maxTokens: 2_048,
        inputModalities: ['text', 'image'], nativeTools: ['web-search'],
        reasoning: { efforts: [{ id: high, name: 'High' }], defaultEffort: high },
      }],
      discoverModels: discover,
      fetch,
    })

    await expect(provider.modelCatalog('static-route')).resolves.toMatchObject({
      state: 'static',
      models: [{ id: 'declared-model', inputModalities: ['text', 'image'], nativeTools: ['web-search'] }],
    })
    await expect(provider.resolveModel('static-route', 'declared-model')).resolves.toMatchObject({
      id: 'declared-model', context: { contextWindow: 64_000 },
      defaultMaxTokens: 2_048, maxOutputTokens: 2_048,
      reasoning: { defaultEffort: 'high' }, nativeTools: ['web-search'],
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    const configuredEmptyDiscover = vi.fn(() => Promise.resolve([{ id: 'ignored' }]))
    const configuredEmpty = createHttpProvider({
      displayName: 'Configured empty', protocol: openAiResponsesProtocol,
      baseUrl: 'https://configured-empty.invalid', auth: { kind: 'none' },
      models: [], discoverModels: configuredEmptyDiscover,
    })
    await expect(configuredEmpty.modelCatalog('configured-empty')).resolves.toMatchObject({
      state: 'static', models: [],
    })
    expect(configuredEmptyDiscover).not.toHaveBeenCalled()

    const discoveredEmpty = createHttpProvider({
      displayName: 'Discovered empty', protocol: openAiResponsesProtocol,
      baseUrl: 'https://discovered-empty.invalid', auth: { kind: 'none' },
      discoverModels: () => Promise.resolve([]),
    })
    await expect(discoveredEmpty.modelCatalog('discovered-empty')).resolves.toMatchObject({
      state: 'empty', models: [],
    })

    const failed = createHttpProvider({
      displayName: 'Failed discovery', protocol: openAiResponsesProtocol,
      baseUrl: 'https://failed-discovery.invalid', auth: { kind: 'none' },
      discoverModels: () => Promise.reject(new Error('private discovery failure')),
    })
    await expect(failed.modelCatalog('failed-discovery')).rejects.toThrow(/catalog is unavailable/i)
  })

  it('propagates catalog cancellation through the public adapter signal', async () => {
    const controller = new AbortController()
    let signalSeen: AbortSignal | undefined
    let started: (() => void) | undefined
    const discoveryStarted = new Promise<void>(resolve => { started = resolve })
    const provider = createRuntimeHttpProvider({
      displayName: 'Abortable Catalog',
      protocol: defineWireProtocol({ id: 'abortable-catalog', defaultDialect: {},
        endpointPath: () => '/generate', serialize: () => ({}), async *translate() {} }),
      baseUrl: 'https://catalog.invalid',
      auth: { kind: 'none' },
      discoverModels: ({ signal }) => {
        signalSeen = signal
        started?.()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })

    const pending = provider.listModels('catalog', controller.signal)
    await discoveryStarted
    controller.abort(new Error('catalog caller cancelled'))
    await expect(pending).rejects.toThrow('catalog caller cancelled')
    expect(signalSeen?.aborted).toBe(true)
  })

  it('refuses document input for a model that does not declare it, and sends it for one that does', async () => {
    const documentMessage = {
      ...createTextMessage('summarize'),
      content: [{
        type: 'document' as const,
        source: { kind: 'base64' as const, mediaType: 'application/pdf' as const, data: 'JVBER' },
        filename: 'report.pdf',
      }],
    }

    const textOnly = createHttpProvider({
      displayName: 'Text only', protocol: openAiResponsesProtocol,
      baseUrl: 'https://text-only.invalid', auth: { kind: 'none' },
      models: [{ id: 'm', inputModalities: ['text', 'image'] }],
    })
    // Reaching the transport at all would mean the gate failed, so no fetch is stubbed.
    await expect(drain(textOnly.stream({
      provider: 'text-only', model: 'm', messages: [documentMessage],
    }))).rejects.toMatchObject({
      code: MODEL_ERROR_CODES.UNSUPPORTED_CONTENT,
      message: /does not accept document input/,
    })

    // An uncatalogued model defaults to text-only, so it is refused too.
    const uncatalogued = createHttpProvider({
      displayName: 'Uncatalogued', protocol: openAiResponsesProtocol,
      baseUrl: 'https://uncatalogued.invalid', auth: { kind: 'none' },
    })
    await expect(drain(uncatalogued.stream({
      provider: 'uncatalogued', model: 'm', messages: [documentMessage],
    }))).rejects.toMatchObject({ code: MODEL_ERROR_CODES.UNSUPPORTED_CONTENT })

    const captured = stubFetch([() => sseResponse(RESPONSES_OK)])
    const capable = createHttpProvider({
      displayName: 'Document capable', protocol: openAiResponsesProtocol,
      baseUrl: 'https://document-capable.invalid', auth: { kind: 'none' },
      models: [{ id: 'm', inputModalities: ['text', 'document'] }],
    })
    await drain(capable.stream({
      provider: 'document-capable', model: 'm', messages: [documentMessage],
    }))
    expect(captured[0]?.body).toMatchObject({
      input: [{
        type: 'message',
        content: [{
          type: 'input_file', filename: 'report.pdf',
          file_data: 'data:application/pdf;base64,JVBER',
        }],
      }],
    })
  })

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

  it('uses portable manual redirect mode and never follows or replays a POST', async () => {
    const calls: Array<{ url: string; proof: string | null }> = []
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      expect(init?.method).toBe('POST')
      calls.push({
        url: String(_input),
        proof: new Headers(init?.headers).get('x-custom-proof'),
      })
      return Promise.resolve(new Response(null, {
        status: 307,
        headers: { location: 'https://escaped.invalid/responses' },
      }))
    })
    const provider = boundedProvider({
      fetch,
      auth: { kind: 'dynamic', resolve: () => ({ 'x-custom-proof': 'private-proof' }) },
    })

    await expect(drain(provider.stream({
      provider: 'bounded', model: 'm', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{
      url: 'https://bounded.invalid/responses',
      proof: 'private-proof',
    }])
  })

  it('rejects opaque and already-followed redirect responses from custom fetch implementations', async () => {
    for (const marker of ['opaque', 'followed'] as const) {
      const response = sseResponse(RESPONSES_OK)
      Object.defineProperty(response, marker === 'opaque' ? 'type' : 'redirected', {
        configurable: true,
        value: marker === 'opaque' ? 'opaqueredirect' : true,
      })
      const fetch = vi.fn(() => Promise.resolve(response))
      const provider = boundedProvider({ fetch })
      await expect(drain(provider.stream({
        provider: 'bounded', model: 'm', messages: [createTextMessage('hello')],
      }))).rejects.toMatchObject({ code: HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
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

  it('observes credential resolution without retaining credential values or labels', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const observed = recordingPort()
    const handle = observedRegistry(observedProvider({
      auth: {
        kind: 'bearer',
        token: () => 'top-secret-token',
        label: '/private/credential/location',
      },
    }), observed.port).stream(observedRequest())
    await drain(handle)

    const credentialEvents = observed.events.filter(event => event.name === 'sdk.credential.operation')
    expect(credentialEvents.map(event => [event.phase, event.data])).toEqual([
      ['start', { provider: 'observed-http', operation: 'resolve' }],
      ['end', { provider: 'observed-http', operation: 'resolve', status: 'success' }],
    ])
    const serialized = JSON.stringify(credentialEvents)
    expect(serialized).not.toContain('top-secret-token')
    expect(serialized).not.toContain('/private/credential/location')
  })

  it('observes catalog failures with safe origin and no raw error or authorization header', async () => {
    stubFetch([() => sseResponse(RESPONSES_OK)])
    const observed = recordingPort()
    const handle = observedRegistry(observedProvider({
      auth: { kind: 'bearer', token: 'top-secret-token' },
      discoverModels: async () => {
        const error = new Error('catalog leaked top-secret-token') as Error & { code: string }
        error.name = 'top-secret-token'
        error.code = 'top-secret-token'
        throw error
      },
    }), observed.port).stream(observedRequest())
    await drain(handle)

    const catalogEvents = observed.events.filter(event => event.name === 'sdk.integration.request')
    expect(catalogEvents).toHaveLength(2)
    expect(catalogEvents[0]?.data).toEqual({
      integration: 'model-catalog',
      provider: 'observed-http',
      operation: 'discover',
      origin: 'https://observed.invalid',
    })
    expect(catalogEvents[1]?.data).toMatchObject({
      status: 'error',
      error: { type: 'Error', message: 'model catalog operation failed' },
    })
    const serialized = JSON.stringify(catalogEvents)
    expect(serialized).not.toContain('top-secret-token')
    expect(serialized).not.toContain('/v1')
  })

  it('keeps partial usage in attempt accounting without emitting an inexact TokenUsage', async () => {
    stubFetch([() => sseResponse([
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10}}}',
    ])])
    const handle = observedRegistry().stream(observedRequest())
    const chunks = await drain(handle)
    const report = await handle.report

    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(report).toMatchObject({
      coverage: 'partial',
      reported: { inputTokens: 10 },
      authoritative: false,
    })
    expect(report.attempts[0]).toMatchObject({
      coverage: 'partial',
      reported: { inputTokens: 10 },
    })
  })

  it('records malformed usage safely and withholds it from SDK consumers', async () => {
    stubFetch([() => sseResponse([
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":"PRIVATE_USAGE/VALUE~SENTINEL%"}}}}',
    ])])
    const handle = observedRegistry().stream(observedRequest())
    const chunks = await drain(handle)
    const report = await handle.report

    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(report).toMatchObject({ coverage: 'partial', authoritative: false })
    expect(report.attempts[0]).toMatchObject({
      coverage: 'partial',
      reported: { inputTokens: 10, outputTokens: 2 },
      error: { code: OBSERVATION_ERROR_CODES.USAGE_INVALID },
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_USAGE/VALUE~SENTINEL%')
  })

  it('captures error response IDs and never copies a raw provider body into attempt reports', async () => {
    stubFetch([() => new Response('{"error":{"message":"PRIVATE_PROVIDER/BODY~SENTINEL%"}}', {
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
    expect(JSON.stringify(report.attempts)).not.toContain('PRIVATE_PROVIDER/BODY~SENTINEL%')
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

  it('accounts for every physical attempt when the retry ceiling is exhausted', async () => {
    stubFetch([
      () => new Response('{"error":{"message":"busy one"}}', { status: 500 }),
      () => new Response('{"error":{"message":"busy two"}}', { status: 500 }),
    ])
    const adapter = withRetry(observedProvider(), {
      policy: {
        mode: 'normal', maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    const handle = observedRegistry(adapter).stream(observedRequest())
    await drain(handle)
    const report = await handle.report

    expect(report).toMatchObject({
      status: 'error', coverage: 'missing', authoritative: false,
      possiblyBilledAttemptsWithoutUsage: 2,
    })
    expect(report.attempts.map(attempt => ({
      number: attempt.attemptNumber,
      status: attempt.status,
      dispatch: attempt.dispatchState,
      coverage: attempt.coverage,
      code: attempt.error?.code,
    }))).toEqual([
      { number: 1, status: 'error', dispatch: 'sent', coverage: 'missing', code: 'SERVER' },
      { number: 2, status: 'error', dispatch: 'sent', coverage: 'missing', code: 'SERVER' },
    ])
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

  it('accounts for post-dispatch timeout and truncated stream failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const timedOut = observedRegistry(observedProvider({ requestTimeoutMs: 10 })).stream(observedRequest())
    await drain(timedOut)
    expect(await timedOut.report).toMatchObject({
      status: 'error', coverage: 'missing', possiblyBilledAttemptsWithoutUsage: 1,
      attempts: [expect.objectContaining({
        status: 'error', dispatchState: 'unknown', coverage: 'missing',
        error: expect.objectContaining({ code: 'TIMEOUT' }),
      })],
    })

    vi.unstubAllGlobals()
    stubFetch([() => sseResponse([
      'data: {"type":"response.created","response":{"id":"truncated"}}',
    ])])
    const truncated = observedRegistry().stream(observedRequest())
    await drain(truncated)
    expect(await truncated.report).toMatchObject({
      status: 'error', coverage: 'missing', possiblyBilledAttemptsWithoutUsage: 1,
      attempts: [expect.objectContaining({
        status: 'error', dispatchState: 'sent', coverage: 'missing',
        error: expect.objectContaining({ code: 'STREAM_CLOSED' }),
      })],
    })
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
