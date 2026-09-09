import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_ERROR_CODES,
  createTextMessage,
  withRetry,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import {
  HTTP_PROVIDER_ERROR_CODES,
  createRuntimeHttpProvider,
  defineWireProtocol,
  type RuntimeHttpProviderOptions,
} from '@alvin0/ai-agent-sdk-provider-http'

const encoder = new TextEncoder()

const protocol = defineWireProtocol({
  id: 'sse-matrix',
  defaultDialect: {},
  endpointPath: () => '/stream',
  serialize: () => ({ prompt: 'test' }),
  async *translate(events) {
    for await (const event of events) {
      if (event.data === 'finish') {
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      } else {
        yield { type: 'text-delta' as const, index: 0, text: event.data }
      }
    }
  },
})

type ProviderOptions = RuntimeHttpProviderOptions<Record<string, never>>

function provider(
  fetch: typeof globalThis.fetch,
  options: Partial<Omit<ProviderOptions, 'displayName' | 'protocol' | 'baseUrl' | 'auth' | 'fetch'>> = {},
) {
  return createRuntimeHttpProvider({
    displayName: 'SSE Matrix',
    protocol,
    baseUrl: 'https://sse-matrix.invalid',
    auth: { kind: 'none' },
    fetch,
    ...options,
  })
}

function request() {
  return { provider: 'sse-matrix', model: 'model', messages: [createTextMessage('test')] }
}

async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

function byteResponse(
  chunks: readonly string[],
  headers: Headers | Readonly<Record<string, string>> = { 'content-type': 'text/event-stream' },
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('provider-http SSE transport contract', () => {
  it.each([
    ['missing', new Headers()],
    ['wrong', new Headers({ 'content-type': 'application/json' })],
  ])('rejects a %s SSE media type before parsing', async (_name, headers) => {
    const fetch = vi.fn(() => Promise.resolve(byteResponse(['data: finish\n\n'], headers)))
    await expect(drain(provider(fetch).stream(request()))).rejects.toMatchObject({
      code: HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID,
    })
  })

  it('accepts case-insensitive text/event-stream with parameters', async () => {
    const fetch = vi.fn(() => Promise.resolve(byteResponse(
      ['data: finish\n\n'],
      { 'content-type': 'Text/Event-Stream; charset=utf-8' },
    )))
    await expect(drain(provider(fetch).stream(request()))).resolves.toEqual([
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('resets one idle deadline from comment-only heartbeat body reads', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode(': one\n\n')), 6)
        setTimeout(() => controller.enqueue(encoder.encode(': two\n\n')), 12)
        setTimeout(() => controller.enqueue(encoder.encode(': three\n\n')), 18)
        setTimeout(() => controller.enqueue(encoder.encode('data: finish\n\n')), 24)
        setTimeout(() => controller.close(), 25)
      },
    }), { headers: { 'content-type': 'text/event-stream' } })))
    const result = drain(provider(fetch, {
      streamIdleTimeoutMs: 10,
      requestTimeoutMs: 1_000,
    }).stream(request()))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30)
    await expect(result).resolves.toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('keeps the overall request deadline authoritative during a slow-loris heartbeat stream', async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          heartbeat = setInterval(() => controller.enqueue(encoder.encode(': alive\n\n')), 5)
          init?.signal?.addEventListener('abort', () => {
            if (heartbeat !== undefined) clearInterval(heartbeat)
            controller.error(init.signal?.reason)
          }, { once: true })
        },
        cancel() { if (heartbeat !== undefined) clearInterval(heartbeat) },
      })
      return Promise.resolve(new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      }))
    })
    await expect(drain(provider(fetch, {
      streamIdleTimeoutMs: 20,
      requestTimeoutMs: 60,
    }).stream(request()))).rejects.toMatchObject({
      code: MODEL_ERROR_CODES.TIMEOUT,
      message: expect.stringMatching(/request exceeded/i),
    })
  })

  it('maps clean EOF before finish to STREAM_CLOSED after preserving visible output', async () => {
    const seen: StreamChunk[] = []
    const source = provider(() => Promise.resolve(byteResponse(['data: visible\n\n']))).stream(request())
    await expect((async () => {
      for await (const chunk of source) seen.push(chunk)
    })()).rejects.toMatchObject({ code: MODEL_ERROR_CODES.STREAM_CLOSED })
    expect(seen).toEqual([{ type: 'text-delta', index: 0, text: 'visible' }])
  })

  it.each([
    ['duplicate finish', 'data: finish\n\ndata: finish\n\n'],
    ['output after finish', 'data: finish\n\ndata: late\n\n'],
  ])('rejects %s without exposing the withheld terminal', async (_name, body) => {
    const seen: StreamChunk[] = []
    const source = provider(() => Promise.resolve(byteResponse([body]))).stream(request())
    await expect((async () => {
      for await (const chunk of source) seen.push(chunk)
    })()).rejects.toMatchObject({ code: MODEL_ERROR_CODES.MALFORMED_RESPONSE })
    expect(seen).toEqual([])
  })

  it.each([
    ['event count', { maxSseEvents: 2 }, ['data: a\n\ndata: b\n\ndata: finish\n\n'], HTTP_PROVIDER_ERROR_CODES.SSE_LIMIT_EXCEEDED],
    ['event chars', { maxSseEventChars: 3 }, ['data: four\n\n'], HTTP_PROVIDER_ERROR_CODES.SSE_LIMIT_EXCEEDED],
    ['raw chunks', { maxResponseChunks: 1 }, [': first\n\n', 'data: finish\n\n'], MODEL_ERROR_CODES.TRANSPORT],
    ['response bytes', { maxResponseBytes: 8 }, ['data: finish\n\n'], MODEL_ERROR_CODES.TRANSPORT],
  ] as const)('enforces the %s bound', async (_name, limits, chunks, code) => {
    await expect(drain(provider(
      () => Promise.resolve(byteResponse(chunks)),
      limits,
    ).stream(request()))).rejects.toMatchObject({ code })
  })

  it('does not reconnect when the parser receives an SSE retry field', async () => {
    const fetch = vi.fn(() => Promise.resolve(byteResponse([
      'retry: 1\ndata: finish\n\n',
    ])))
    await expect(drain(provider(fetch).stream(request()))).resolves.toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries before output but never retries after the first visible chunk', async () => {
    let beforeAttempt = 0
    const beforeFetch = vi.fn(() => Promise.resolve(++beforeAttempt === 1
      ? new Response('busy', { status: 500 })
      : byteResponse(['data: finish\n\n'])))
    const retryOptions = {
      policy: {
        mode: 'normal' as const,
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    }
    await expect(drain(withRetry(provider(beforeFetch), retryOptions).stream(request())))
      .resolves.toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(beforeFetch).toHaveBeenCalledTimes(2)

    const afterFetch = vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: visible\n\n'))
        setTimeout(() => controller.error(new Error('connection failed after output')), 5)
      },
    }), { headers: { 'content-type': 'text/event-stream' } })))
    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const chunk of withRetry(provider(afterFetch), retryOptions).stream(request())) {
        seen.push(chunk)
      }
    })()).rejects.toBeDefined()
    expect(seen).toEqual([{ type: 'text-delta', index: 0, text: 'visible' }])
    expect(afterFetch).toHaveBeenCalledTimes(1)
  })
})
