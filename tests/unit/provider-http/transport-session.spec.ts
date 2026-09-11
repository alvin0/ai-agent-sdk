/**
 * Sanity gate for the shared transport safety chain.
 *
 * Feature: embedding-support — Requirements 13.1, 13.3, 13.4, 13.5, 13.6.
 *
 * These are example-based checks that the chain extracted into
 * `transport/session.ts` performs each step it took over from the generation
 * pipeline: one fused signal, a best-effort redacted observer, attempt accounting
 * closed exactly once with the right `dispatchState`, the redirect guard, non-2xx
 * mapping with `retry-after` and request id, and teardown of a body the consumer
 * abandoned. The exhaustive properties over the same claims are Properties 33-36.
 */

import { describe, expect, it } from 'vitest'
import {
  MODEL_ERROR_CODES,
  ModelError,
  resolveRetryPolicy,
  type EndProviderAttemptInput,
  type ModelInvocationContext,
  type ProviderAttemptHandle,
  type StartProviderAttemptInput,
} from '../../../packages/core/src/index.ts'
import { HTTP_PROVIDER_ERROR_CODES } from '../../../packages/provider-http/src/common/config.ts'
import type { HttpTransportConnection } from '../../../packages/provider-http/src/transport/connection.ts'
import { transportStream } from '../../../packages/provider-http/src/transport/stream.ts'
import {
  withTransportSession,
  type HttpTransportRequestInput,
  type HttpTransportSession,
  type WireRequestRecord,
} from '../../../packages/provider-http/src/transport/session.ts'

const RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }, 'test.retryPolicy')

function connectionOf(overrides: Partial<HttpTransportConnection> = {}): HttpTransportConnection {
  return {
    baseUrl: 'https://transport.invalid',
    headers: { 'authorization': 'Bearer secret-token', 'content-type': 'application/json' },
    retryPolicy: RETRY_POLICY,
    ...overrides,
  }
}

function inputOf(
  fetch: typeof globalThis.fetch,
  overrides: Partial<HttpTransportRequestInput> = {},
): HttpTransportRequestInput {
  const connection = overrides.connection ?? connectionOf({ fetch })
  return {
    displayName: 'Transport Test',
    provider: 'transport-test',
    model: 'model-a',
    path: '/embeddings',
    accept: 'application/json',
    body: { value: { prompt: 'hi' }, encoded: '{"prompt":"hi"}', bytes: 15 },
    ...overrides,
    connection: { ...connection, fetch },
  }
}

interface AttemptLedger {
  readonly starts: StartProviderAttemptInput[]
  readonly ends: EndProviderAttemptInput[]
  readonly context: ModelInvocationContext
}

function ledger(options: { readonly rejectAdmission?: unknown } = {}): AttemptLedger {
  const starts: StartProviderAttemptInput[] = []
  const ends: EndProviderAttemptInput[] = []
  const handle: ProviderAttemptHandle = {
    attemptId: 'attempt-1',
    attemptNumber: 1,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    end(input) {
      ends.push(input)
      return { status: 'missing', reported: undefined, attempts: 1 } as never
    },
  }
  return {
    starts,
    ends,
    context: {
      startProviderAttempt: async (input) => {
        starts.push(input)
        if ('rejectAdmission' in options) throw options.rejectAdmission
        return handle
      },
    },
  }
}

function jsonResponse(
  body: string,
  init: ResponseInit = { status: 200, headers: { 'content-type': 'application/json' } },
): Response {
  return new Response(body, init)
}

/** Read one value out of the chain, exercising the streaming shape. */
async function drainBody(session: HttpTransportSession): Promise<string> {
  return await session.response.text()
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('withTransportSession signal fusion (Requirement 13.3)', () => {
  it('classifies a fired request deadline as TIMEOUT', async () => {
    const stream = withTransportSession(
      inputOf(
        async () => await new Promise<Response>(() => {}),
        { connection: connectionOf({ requestTimeoutMs: 20 }) },
      ),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({
      code: MODEL_ERROR_CODES.TIMEOUT,
    })
  })

  it('classifies a caller abort as ABORTED even when the deadline also fired', async () => {
    const caller = new AbortController()
    const stream = withTransportSession(
      inputOf(
        async () => await new Promise<Response>(() => {}),
        { connection: connectionOf({ requestTimeoutMs: 40 }), signal: caller.signal },
      ),
      async function* (session) { yield await drainBody(session) },
    )
    const pending = collect(stream)
    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: MODEL_ERROR_CODES.ABORTED })
  })

  it('aborts the fused signal and releases the body when the consumer stops early', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{}')) },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    let observed: AbortSignal | undefined
    const stream = transportStream(
      inputOf(async () => response),
      async function* (session) {
        observed = session.signal
        yield 'first'
        yield 'second'
      },
    )
    for await (const value of stream) {
      expect(value).toBe('first')
      break
    }
    expect(observed?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })
})

describe('withTransportSession request observation (Requirement 13.4)', () => {
  it('redacts credentials and still dispatches when the observer throws', async () => {
    const records: WireRequestRecord[] = []
    const values = await collect(withTransportSession(
      inputOf(async () => jsonResponse('{"ok":true}'), {
        observeRequest: (record) => {
          records.push(record)
          throw new Error('debug sink is broken')
        },
      }),
      async function* (session) { yield await drainBody(session) },
    ))
    expect(values).toEqual(['{"ok":true}'])
    expect(records).toHaveLength(1)
    expect(records[0]?.headers.authorization).toBe('[REDACTED]')
    expect(records[0]?.headers['content-type']).toBe('application/json')
    expect(records[0]?.url).toBe('https://transport.invalid/embeddings')
    expect(records[0]?.bodyBytes).toBe(15)
  })

  it('does not let a hanging observer hold dispatch past its deadline', async () => {
    const values = await collect(withTransportSession(
      inputOf(async () => jsonResponse('{"ok":true}'), {
        connection: connectionOf({ requestLoggerTimeoutMs: 10 }),
        observeRequest: async () => await new Promise<void>(() => {}),
      }),
      async function* (session) { yield await drainBody(session) },
    ))
    expect(values).toEqual(['{"ok":true}'])
  })
})

describe('withTransportSession attempt accounting (Requirement 13.5)', () => {
  it('closes the attempt exactly once with dispatchState sent on success', async () => {
    const accounting = ledger()
    await collect(withTransportSession(
      inputOf(
        async () => jsonResponse('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-42' },
        }),
        { context: accounting.context },
      ),
      async function* (session) {
        session.reportUsage({ inputTokens: 7, outputTokens: 3 })
        session.reportOutcome('success')
        yield await drainBody(session)
      },
    ))
    expect(accounting.starts).toEqual([{
      provider: 'transport-test',
      model: 'model-a',
      method: 'POST',
      origin: 'https://transport.invalid',
    }])
    expect(accounting.ends).toHaveLength(1)
    expect(accounting.ends[0]).toMatchObject({
      status: 'success',
      dispatchState: 'sent',
      httpStatus: 200,
      providerRequestId: 'req-42',
      reported: { inputTokens: 7, outputTokens: 3 },
    })
  })

  it('records dispatchState unknown when the socket itself failed', async () => {
    const accounting = ledger()
    const stream = withTransportSession(
      inputOf(async () => { throw new TypeError('connection reset') }, {
        context: accounting.context,
      }),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({ code: MODEL_ERROR_CODES.TRANSPORT })
    expect(accounting.ends).toHaveLength(1)
    expect(accounting.ends[0]).toMatchObject({ status: 'error', dispatchState: 'unknown' })
  })

  it('rethrows an admission refusal verbatim and opens no dispatch', async () => {
    const refusal = new ModelError('audit mode refused this dispatch', 'AUDIT_REJECTED')
    const accounting = ledger({ rejectAdmission: refusal })
    let fetched = 0
    const stream = withTransportSession(
      inputOf(async () => { fetched++; return jsonResponse('{}') }, {
        context: accounting.context,
      }),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toBe(refusal)
    expect(fetched).toBe(0)
    expect(accounting.ends).toHaveLength(0)
  })

  it('rejects an oversized request before any attempt is opened', async () => {
    const accounting = ledger()
    let fetched = 0
    const stream = withTransportSession(
      inputOf(async () => { fetched++; return jsonResponse('{}') }, {
        connection: connectionOf({ maxRequestBytes: 4 }),
        context: accounting.context,
      }),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({
      code: MODEL_ERROR_CODES.INVALID_REQUEST,
    })
    expect(fetched).toBe(0)
    expect(accounting.starts).toHaveLength(0)
  })
})

describe('withTransportSession response guards (Requirement 13.6)', () => {
  it('refuses a redirect instead of following it', async () => {
    const stream = withTransportSession(
      inputOf(async () => new Response(null, {
        status: 307,
        headers: { location: 'https://elsewhere.invalid/embeddings' },
      })),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({
      code: HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED,
    })
  })

  it('maps a non-2xx with retry-after and a request id', async () => {
    const stream = withTransportSession(
      inputOf(async () => jsonResponse('{"error":{"message":"slow down"}}', {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '2',
          'x-request-id': 'req-429',
        },
      })),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({
      code: MODEL_ERROR_CODES.RATE_LIMIT,
      failure: {
        message: 'slow down',
        code: MODEL_ERROR_CODES.RATE_LIMIT,
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: 'req-429',
      },
    })
  })

  it('honours a provider-specific status mapping override', async () => {
    const stream = withTransportSession(
      inputOf(async () => jsonResponse('{"error":{"message":"nope"}}', { status: 418 }), {
        errorCode: () => 'PROVIDER_TEAPOT',
      }),
      async function* (session) { yield await drainBody(session) },
    )
    await expect(collect(stream)).rejects.toMatchObject({ code: 'PROVIDER_TEAPOT' })
  })
})
