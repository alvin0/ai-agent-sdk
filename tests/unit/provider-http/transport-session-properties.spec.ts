/**
 * Property tests for the shared transport safety chain.
 *
 * Feature: embedding-support — Properties 33, 34, 35, 36.
 *
 * **Validates: Requirements 13.3, 13.4, 13.5, 13.6**
 *
 * `tests/unit/provider-http/transport-session.spec.ts` is the example-based
 * sanity gate for the same chain: it pins one representative case per step. This
 * file is the exhaustive counterpart. Each property enumerates the whole space the
 * requirement talks about — every abort source, every observer behaviour, every
 * position a failure can occupy relative to the dispatch, every redirect shape the
 * Web fetch API can expose — and asserts the invariant over randomly ordered
 * combinations of it rather than over one hand-picked path.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/provider-http/tests/unit/transport/session.spec.ts`.
 * That directory is not covered by any runner: `packages/provider-http/tests/`
 * holds fixtures only, and `packages/provider-http/vitest.config.ts` includes specs
 * out of the ROOT `tests/` tree by relative path. Root `vitest.config.ts` includes
 * `tests/**` exclusively. A spec placed under the package's `tests/unit/` would
 * therefore never run in CI, which is the one failure mode a property test must
 * not have. It sits beside its sanity gate instead.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention the
 * existing property specs established (see `tests/unit/copilot-attempts.spec.ts`)
 * is a seeded mulberry32 generator: a failure reproduces from the printed seed, and
 * no new dependency enters the graph for test-only reasons. Each property runs
 * `RUNS` generated cases, above the spec floor of 100.
 */

import { describe, expect, it } from 'vitest'
// Core arrives through the package entry, exactly as `provider-http` imports it.
// Reaching into `packages/core/src` instead would give this spec a SECOND copy of
// every branded type and error class, and every assertion about the mapped failure
// would then be an assertion about which copy produced it.
import { MODEL_ERROR_CODES, ModelError, resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type {
  EndProviderAttemptInput,
  ModelInvocationContext,
  ProviderAttemptHandle,
  StartProviderAttemptInput,
} from '@alvin0/ai-agent-sdk-core/provider'
import { HTTP_PROVIDER_ERROR_CODES } from '../../../packages/provider-http/src/common/config.ts'
import type { HttpTransportConnection } from '../../../packages/provider-http/src/transport/connection.ts'
import {
  withTransportSession,
  type HttpTransportRequestInput,
  type HttpTransportSession,
  type WireRequestRecord,
} from '../../../packages/provider-http/src/transport/session.ts'
import { transportStream } from '../../../packages/provider-http/src/transport/stream.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 110

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Rng = () => number

function intBelow(rng: Rng, bound: number): number {
  return Math.floor(rng() * bound)
}

function intBetween(rng: Rng, low: number, highInclusive: number): number {
  return low + intBelow(rng, highInclusive - low + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

/**
 * Walk a case list in a shuffled order so no property depends on enumeration order,
 * while still covering every case at least once across `RUNS`.
 */
function coverEvenly<T>(rng: Rng, cases: readonly T[], runs: number): T[] {
  const plan: T[] = []
  while (plan.length < runs) {
    const round = [...cases]
    for (let index = round.length - 1; index > 0; index -= 1) {
      const swap = intBelow(rng, index + 1)
      const left = round[index]
      const right = round[swap]
      if (left === undefined || right === undefined) throw new Error('shuffle out of range')
      round[index] = right
      round[swap] = left
    }
    plan.push(...round)
  }
  return plan.slice(0, runs)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const connection = overrides.connection ?? connectionOf()
  return {
    displayName: 'Transport Property',
    provider: 'transport-property',
    model: 'model-a',
    path: '/embeddings',
    accept: 'application/json',
    body: { value: { prompt: 'hi' }, encoded: '{"prompt":"hi"}', bytes: 15 },
    ...overrides,
    connection: { ...connection, fetch },
  }
}

interface AttemptLedger {
  /** Raw `startProviderAttempt` inputs, counted before core's dedup sees them. */
  readonly starts: StartProviderAttemptInput[]
  /** Raw `attempt.end` inputs; a double close would show up as a second entry. */
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

/** A body whose release is observable, so teardown can be asserted rather than assumed. */
function observableBody(): { readonly stream: ReadableStream<Uint8Array>; released: () => boolean } {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')) },
    cancel() { cancelled = true },
  })
  return { stream, released: () => cancelled }
}

/** Response fields Web fetch exposes as read-only getters but a fixture must forge. */
interface ResponseOverrides {
  readonly redirected?: boolean
  /** `ResponseType` is a DOM lib name; this project compiles against `es2023` + node. */
  readonly type?: 'basic' | 'cors' | 'default' | 'error' | 'opaque' | 'opaqueredirect'
  readonly url?: string
}

function responseWith(
  body: ReadableStream<Uint8Array>,
  init: ResponseInit,
  overrides: ResponseOverrides = {},
): Response {
  const response = new Response(body, init)
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(response, key, { value, configurable: true })
  }
  return response
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

/** The error a run produced, without letting a non-Error escape the assertion. */
async function failureOf(source: AsyncIterable<unknown>): Promise<unknown> {
  try {
    await collect(source)
  } catch (error: unknown) {
    return error
  }
  return undefined
}

/**
 * The facts a mapped failure must carry, read structurally rather than by class.
 *
 * `instanceof` is deliberately avoided: the transport imports core through the
 * workspace package entry while this spec imports it from source, so the two
 * `ModelError` constructors are different objects even though the error is the
 * right one. The serializable twin is the contract anyway — see `ModelFailure`.
 */
interface FailureFacts {
  readonly code: string | undefined
  readonly message: unknown
  readonly status: unknown
  readonly providerRetryAfterMs: unknown
  readonly requestId: unknown
}

function factsOf(error: unknown): FailureFacts {
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {}
  const failure = typeof record.failure === 'object' && record.failure !== null
    ? record.failure as Record<string, unknown>
    : {}
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: failure.message,
    status: failure.status,
    providerRetryAfterMs: failure.providerRetryAfterMs,
    requestId: failure.requestId,
  }
}

function codeOf(error: unknown): string | undefined {
  return factsOf(error).code
}

// ---------------------------------------------------------------------------
// Property 33
// ---------------------------------------------------------------------------

/**
 * The three sources Requirement 13.3 fuses, plus the one ordering between them
 * that is a contract rather than an accident: a caller who asked for cancellation
 * gets `ABORTED` even when the deadline has also fired, because "you asked me to
 * stop" is more accurate than "I ran out of time".
 */
type AbortSource = 'caller' | 'timeout' | 'consumer' | 'caller-outranks-timeout'

const ABORT_SOURCES: readonly AbortSource[] = [
  'caller',
  'timeout',
  'consumer',
  'caller-outranks-timeout',
]

interface AbortObservation {
  /** The signal the request itself was issued with, when a dispatch happened. */
  readonly dispatched: AbortSignal | undefined
  /** The fused signal `decode` saw, when decoding started. */
  readonly decoded: AbortSignal | undefined
  readonly released: boolean
  readonly code: string | undefined
  /** Wall time the run took, and the deadline it ran under. */
  readonly elapsedMs: number
  readonly timeoutMs: number
}

async function observeAbort(source: AbortSource, rng: Rng): Promise<AbortObservation> {
  const caller = new AbortController()
  let dispatched: AbortSignal | undefined
  let decoded: AbortSignal | undefined
  const body = observableBody()

  if (source === 'consumer') {
    // Nothing aborts from outside: the consumer walking away mid-stream is what
    // must abort the internal teardown controller.
    const stream = transportStream(
      inputOf(async () => new Response(body.stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      async function* (session) {
        decoded = session.signal
        yield 'first'
        yield 'second'
      },
    )
    for await (const value of stream) {
      expect(value).toBe('first')
      break
    }
    return {
      dispatched,
      decoded,
      released: body.released(),
      code: undefined,
      elapsedMs: 0,
      timeoutMs: 0,
    }
  }

  // The deadline is generous for the caller cases on purpose: a transport that
  // dropped the caller's signal out of the fusion would still eventually abort the
  // socket when the deadline fired, and would still be relabelled `ABORTED` on the
  // way out because the caller's signal is aborted by then. Only the WALL TIME
  // separates "the caller's abort reached the wire" from "the deadline did it
  // later", so the run must finish nowhere near the deadline.
  const timeoutMs = source === 'timeout' ? intBetween(rng, 5, 30) : intBetween(rng, 1_000, 1_500)
  const startedAt = Date.now()
  const hangingFetch: typeof globalThis.fetch = async (_url, init) => {
    dispatched = init?.signal ?? undefined
    // Aborting from inside the dispatch pins the abort AFTER the attempt opened,
    // which is what makes the classification deterministic instead of a race.
    if (source === 'caller') caller.abort()
    return await new Promise<Response>(() => {})
  }

  if (source === 'caller-outranks-timeout') {
    caller.abort()
    await new Promise<void>(resolve => setTimeout(resolve, intBetween(rng, 1, 3)))
  }

  const error = await failureOf(withTransportSession(
    inputOf(hangingFetch, {
      connection: connectionOf({ requestTimeoutMs: timeoutMs }),
      signal: caller.signal,
    }),
    async function* (session) {
      decoded = session.signal
      yield await session.response.text()
    },
  ))
  return {
    dispatched,
    decoded,
    released: body.released(),
    code: codeOf(error),
    elapsedMs: Date.now() - startedAt,
    timeoutMs,
  }
}

describe('Feature: embedding-support, Property 33: Signal hợp nhất bao phủ cả ba nguồn abort', () => {
  it(`maps every abort source to its own failure class across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_33)
    for (const source of coverEvenly(rng, ABORT_SOURCES, RUNS)) {
      const observed = await observeAbort(source, rng)
      const context = `abort source ${source}`
      if (source === 'consumer') {
        // No error surfaces: the consumer chose to stop. What must be true is that
        // the fused signal aborted anyway, so an in-flight response is torn down.
        expect(observed.code, context).toBeUndefined()
        expect(observed.decoded?.aborted, context).toBe(true)
        expect(observed.released, context).toBe(true)
        continue
      }
      expect(observed.code, context).toBe(
        source === 'timeout' ? MODEL_ERROR_CODES.TIMEOUT : MODEL_ERROR_CODES.ABORTED,
      )
      if (source === 'caller') {
        // The caller's abort is what cut the request, not the deadline: the signal
        // the request carried is aborted, and the run ended far short of the bound.
        expect(observed.dispatched?.aborted, context).toBe(true)
        expect(observed.elapsedMs, `${context} waited for the deadline instead`)
          .toBeLessThan(observed.timeoutMs / 2)
      }
      if (source === 'timeout') expect(observed.dispatched?.aborted, context).toBe(true)
      // `caller-outranks-timeout` pre-aborts, so there is no dispatch to inspect.
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Property 34
// ---------------------------------------------------------------------------

/** Every way a diagnostic sink can misbehave without being allowed to veto dispatch. */
type ObserverBehaviour = 'return' | 'throw' | 'reject' | 'hang' | 'absent'

const OBSERVER_BEHAVIOURS: readonly ObserverBehaviour[] = [
  'return',
  'throw',
  'reject',
  'hang',
  'absent',
]

/**
 * Header names the redactor must catch by NAME SHAPE alone, with no provenance
 * hint — the conservative fallback in `isSensitiveHeaderName`.
 */
const SENSITIVE_NAMES: readonly string[] = [
  'authorization',
  'Authorization',
  'api-key',
  'x-api-key',
  'x_goog_api_key',
  'x-session-token',
  'cookie',
  'x-account-id',
  'x-amz-signature',
  'x-client-secret',
]

/** Header names that carry nothing secret and must survive verbatim. */
const PUBLIC_NAMES: readonly string[] = [
  'content-type',
  'accept-encoding',
  'x-provider-region',
  'user-agent',
]

interface HeaderPlan {
  readonly headers: Record<string, string>
  /** Names whose value must come back as `[REDACTED]`. */
  readonly redacted: readonly string[]
  /** Names whose value must come back untouched, with the value they carried. */
  readonly preserved: ReadonlyMap<string, string>
  /** Every secret value placed on the wire; none may appear in the record. */
  readonly secrets: readonly string[]
  /** Auth-declared provenance names, which need not look sensitive at all. */
  readonly sensitiveHeaderNames: readonly string[]
}

function planHeaders(rng: Rng, run: number): HeaderPlan {
  const headers: Record<string, string> = {}
  const redacted: string[] = []
  const preserved = new Map<string, string>()
  const secrets: string[] = []

  for (const name of new Set(
    Array.from({ length: intBetween(rng, 1, 4) }, () => pick(rng, SENSITIVE_NAMES)),
  )) {
    const secret = `secret-${run}-${name}-${intBelow(rng, 1_000_000)}`
    headers[name] = secret
    secrets.push(secret)
    redacted.push(name)
  }
  for (const name of new Set(
    Array.from({ length: intBetween(rng, 0, 3) }, () => pick(rng, PUBLIC_NAMES)),
  )) {
    const value = `public-${name}-${intBelow(rng, 1_000)}`
    headers[name] = value
    preserved.set(name, value)
  }
  // A name only the auth layer knows is sensitive. Provenance, not spelling, is
  // what has to cover it: `x-gateway-passport` matches no pattern.
  const provenanceNames: string[] = []
  if (rng() < 0.5) {
    const name = 'x-gateway-passport'
    const secret = `passport-${run}-${intBelow(rng, 1_000_000)}`
    headers[name] = secret
    secrets.push(secret)
    redacted.push(name)
    provenanceNames.push(name)
  }
  return { headers, redacted, preserved, secrets, sensitiveHeaderNames: provenanceNames }
}

describe('Feature: embedding-support, Property 34: Observer wire-request là best-effort và không rò rỉ credential', () => {
  it(`dispatches and redacts under every observer behaviour across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_34)
    const plan = coverEvenly(rng, OBSERVER_BEHAVIOURS, RUNS)
    for (const [run, behaviour] of plan.entries()) {
      const context = `observer ${behaviour} (run ${run})`
      const layout = planHeaders(rng, run)
      const records: WireRequestRecord[] = []
      let fetches = 0

      const observeRequest = (record: WireRequestRecord): Promise<void> | void => {
        records.push(record)
        if (behaviour === 'throw') throw new Error('debug sink is broken')
        if (behaviour === 'reject') return Promise.reject(new Error('debug sink rejected'))
        if (behaviour === 'hang') return new Promise<void>(() => {})
        return undefined
      }

      const values = await collect(withTransportSession(
        inputOf(async () => { fetches += 1; return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) }, {
          connection: connectionOf({
            headers: layout.headers,
            sensitiveHeaderNames: layout.sensitiveHeaderNames,
            requestLoggerTimeoutMs: intBetween(rng, 5, 25),
          }),
          ...behaviour === 'absent' ? {} : { observeRequest },
        }),
        async function* (session) { yield await session.response.text() },
      ))

      // Best-effort means exactly this: the observer's fate never reaches the caller.
      expect(values, context).toEqual(['{"ok":true}'])
      expect(fetches, context).toBe(1)
      expect(records, context).toHaveLength(behaviour === 'absent' ? 0 : 1)

      const record = records[0]
      if (record === undefined) continue
      const serialized = JSON.stringify(record.headers)
      for (const secret of layout.secrets) {
        expect(serialized.includes(secret), `${context} leaked a credential`).toBe(false)
      }
      for (const name of layout.redacted) {
        expect(record.headers[name], `${context} header ${name}`).toBe('[REDACTED]')
      }
      for (const [name, value] of layout.preserved) {
        expect(record.headers[name], `${context} header ${name}`).toBe(value)
      }
      expect(record.url, context).toBe('https://transport.invalid/embeddings')
      expect(record.bodyBytes, context).toBe(15)
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Property 35
// ---------------------------------------------------------------------------

/**
 * Every position a failure can occupy relative to the dispatch.
 *
 * The list is ordered by how far the request got, which is exactly what
 * `dispatchState` reports: nothing left the process (`not-sent`), bytes may or may
 * not have reached the server (`unknown`), or a response came back (`sent`).
 */
type FailurePoint =
  | 'oversized-request'
  | 'admission-refused'
  | 'caller-abort-after-dispatch'
  | 'deadline-after-dispatch'
  | 'socket-failure'
  | 'redirect-refused'
  | 'non-2xx'
  | 'decode-rejects-media-type'
  | 'body-read-failure'
  | 'consumer-early-stop'
  | 'success'

const FAILURE_POINTS: readonly FailurePoint[] = [
  'oversized-request',
  'admission-refused',
  'caller-abort-after-dispatch',
  'deadline-after-dispatch',
  'socket-failure',
  'redirect-refused',
  'non-2xx',
  'decode-rejects-media-type',
  'body-read-failure',
  'consumer-early-stop',
  'success',
]

interface AttemptExpectation {
  /** How many raw `attempt.end` calls the run must produce. */
  readonly ends: 0 | 1
  readonly dispatchState?: 'not-sent' | 'sent' | 'unknown'
  readonly attemptStatus?: 'success' | 'error' | 'aborted' | 'unknown'
  /** Whether the socket may be opened at all on this path. */
  readonly fetches: 0 | 1
  readonly code?: string
}

const ATTEMPT_EXPECTATIONS: Readonly<Record<FailurePoint, AttemptExpectation>> = {
  // Bounds are checked before an attempt exists, so there is nothing to close.
  'oversized-request': { ends: 0, fetches: 0, code: MODEL_ERROR_CODES.INVALID_REQUEST },
  // Audit mode refused: no handle was ever handed over, and nothing was sent.
  'admission-refused': { ends: 0, fetches: 0 },
  'caller-abort-after-dispatch': {
    ends: 1, fetches: 1, dispatchState: 'unknown', attemptStatus: 'aborted',
    code: MODEL_ERROR_CODES.ABORTED,
  },
  'deadline-after-dispatch': {
    ends: 1, fetches: 1, dispatchState: 'unknown', attemptStatus: 'error',
    code: MODEL_ERROR_CODES.TIMEOUT,
  },
  'socket-failure': {
    ends: 1, fetches: 1, dispatchState: 'unknown', attemptStatus: 'error',
    code: MODEL_ERROR_CODES.TRANSPORT,
  },
  'redirect-refused': {
    ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'error',
    code: HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED,
  },
  'non-2xx': {
    ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'error',
    code: MODEL_ERROR_CODES.SERVER,
  },
  'decode-rejects-media-type': {
    ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'error',
    code: HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID,
  },
  'body-read-failure': {
    ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'error',
    code: MODEL_ERROR_CODES.TRANSPORT,
  },
  // A consumer that walks away reported no outcome, so the ledger says so.
  'consumer-early-stop': { ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'unknown' },
  'success': { ends: 1, fetches: 1, dispatchState: 'sent', attemptStatus: 'success' },
}

interface AttemptRun {
  readonly starts: number
  readonly ends: readonly EndProviderAttemptInput[]
  readonly fetches: number
  readonly code: string | undefined
  readonly rethrownVerbatim: boolean
}

async function observeFailurePoint(point: FailurePoint, rng: Rng): Promise<AttemptRun> {
  const refusal = new ModelError('audit mode refused this dispatch', 'AUDIT_REJECTED')
  const accounting = point === 'admission-refused'
    ? ledger({ rejectAdmission: refusal })
    : ledger()
  const caller = new AbortController()
  let fetches = 0

  const respond: typeof globalThis.fetch = async (_url, _init) => {
    fetches += 1
    switch (point) {
      case 'caller-abort-after-dispatch':
        caller.abort()
        return await new Promise<Response>(() => {})
      case 'deadline-after-dispatch':
        return await new Promise<Response>(() => {})
      case 'socket-failure':
        throw new TypeError('connection reset')
      case 'redirect-refused':
        return new Response('{}', {
          status: pick(rng, [301, 302, 303, 307, 308]),
          headers: { location: 'https://elsewhere.invalid/embeddings' },
        })
      case 'non-2xx':
        return new Response('{"error":{"message":"upstream is unwell"}}', {
          status: pick(rng, [500, 502, 503]),
          headers: { 'content-type': 'application/json' },
        })
      case 'body-read-failure':
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) { controller.error(new Error('socket closed mid-body')) },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      default:
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    }
  }

  const connection = point === 'oversized-request'
    ? connectionOf({ maxRequestBytes: intBetween(rng, 1, 14) })
    : connectionOf({
      requestTimeoutMs: point === 'deadline-after-dispatch'
        ? intBetween(rng, 5, 30)
        : intBetween(rng, 500, 800),
    })

  const decode = async function* (session: HttpTransportSession): AsyncGenerator<string> {
    if (point === 'decode-rejects-media-type') {
      throw new ModelError(
        'response media type is not the one this pipeline requires',
        HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID,
      )
    }
    if (point === 'consumer-early-stop') {
      yield 'first'
      yield 'second'
      return
    }
    const text = await session.response.text()
    if (point === 'success') session.reportOutcome('success')
    yield text
  }

  const stream = withTransportSession(
    inputOf(respond, { connection, context: accounting.context, signal: caller.signal }),
    decode,
  )

  let code: string | undefined
  let rethrownVerbatim = false
  if (point === 'consumer-early-stop') {
    for await (const _value of stream) break
  } else {
    const error = await failureOf(stream)
    code = codeOf(error)
    rethrownVerbatim = error === refusal
  }
  return {
    starts: accounting.starts.length,
    ends: accounting.ends,
    fetches,
    code,
    rethrownVerbatim,
  }
}

describe('Feature: embedding-support, Property 35: Attempt accounting đóng đúng một lần trên mọi đường thoát', () => {
  it(`closes the attempt exactly once per exit path across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_35)
    for (const [run, point] of coverEvenly(rng, FAILURE_POINTS, RUNS).entries()) {
      const context = `failure point ${point} (run ${run})`
      const expected = ATTEMPT_EXPECTATIONS[point]
      const observed = await observeFailurePoint(point, rng)

      expect(observed.ends, `${context} closed the attempt the wrong number of times`)
        .toHaveLength(expected.ends)
      expect(observed.fetches, context).toBe(expected.fetches)
      if (expected.code !== undefined) expect(observed.code, context).toBe(expected.code)
      if (point === 'admission-refused') {
        // The refusal is a decision, not a transport failure: it travels verbatim.
        expect(observed.rethrownVerbatim, context).toBe(true)
        expect(observed.starts, context).toBe(1)
      }
      const end = observed.ends[0]
      if (end === undefined) continue
      expect(end.dispatchState, context).toBe(expected.dispatchState)
      expect(
        ['not-sent', 'sent', 'unknown'].includes(end.dispatchState),
        `${context} reported a dispatchState outside the closed set`,
      ).toBe(true)
      expect(end.status, context).toBe(expected.attemptStatus)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Property 36
// ---------------------------------------------------------------------------

/** Every redirect shape the Web fetch API can present, including the opaque one. */
type RedirectShape = 'status' | 'redirected-flag' | 'opaque' | 'final-url-changed'

const REDIRECT_SHAPES: readonly RedirectShape[] = [
  'status',
  'redirected-flag',
  'opaque',
  'final-url-changed',
]

function redirectResponse(shape: RedirectShape, body: ReadableStream<Uint8Array>, rng: Rng): Response {
  const elsewhere = 'https://elsewhere.invalid/embeddings'
  switch (shape) {
    case 'status':
      return responseWith(body, {
        status: pick(rng, [301, 302, 303, 307, 308]),
        headers: { location: elsewhere },
      })
    case 'redirected-flag':
      return responseWith(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }, { redirected: true })
    case 'opaque':
      return responseWith(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }, { type: 'opaqueredirect' })
    case 'final-url-changed':
      return responseWith(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }, { url: elsewhere })
  }
}

/** Statuses whose mapping is a contract, paired with the code they must produce. */
const STATUS_CODES: readonly (readonly [number, string])[] = [
  [401, MODEL_ERROR_CODES.AUTH],
  [403, MODEL_ERROR_CODES.AUTH],
  [400, MODEL_ERROR_CODES.INVALID_REQUEST],
  [404, MODEL_ERROR_CODES.INVALID_REQUEST],
  [413, MODEL_ERROR_CODES.INVALID_REQUEST],
  [422, MODEL_ERROR_CODES.INVALID_REQUEST],
  [429, MODEL_ERROR_CODES.RATE_LIMIT],
  [500, MODEL_ERROR_CODES.SERVER],
  [502, MODEL_ERROR_CODES.SERVER],
  [503, MODEL_ERROR_CODES.SERVER],
]

/** Header names providers use for their correlation id, all of which must be read. */
const REQUEST_ID_HEADERS: readonly string[] = ['request-id', 'x-request-id', 'x-requestid', 'cf-ray']

describe('Feature: embedding-support, Property 36: Redirect guard, error mapping và teardown luôn được áp dụng', () => {
  it(`refuses every redirect shape before a second hop across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_36)
    for (const [run, shape] of coverEvenly(rng, REDIRECT_SHAPES, RUNS).entries()) {
      const context = `redirect shape ${shape} (run ${run})`
      const body = observableBody()
      let fetches = 0
      const error = await failureOf(withTransportSession(
        inputOf(async () => { fetches += 1; return redirectResponse(shape, body.stream, rng) }),
        async function* (session) { yield await session.response.text() },
      ))
      expect(codeOf(error), context).toBe(HTTP_PROVIDER_ERROR_CODES.REDIRECT_REJECTED)
      // One dispatch only: the credential is never replayed to wherever the
      // `location` header points.
      expect(fetches, `${context} followed a second hop`).toBe(1)
      expect(body.released(), `${context} leaked the response body`).toBe(true)
    }
  }, 30_000)

  it(`maps every non-2xx with its retry-after and request id across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_37)
    for (let run = 0; run < RUNS; run += 1) {
      const pair = pick(rng, STATUS_CODES)
      const [status, expectedCode] = pair
      const retryStyle = pick(rng, ['seconds', 'http-date', 'absent'] as const)
      const seconds = intBetween(rng, 1, 120)
      const idHeader = rng() < 0.8 ? pick(rng, REQUEST_ID_HEADERS) : undefined
      const requestId = `req-${run}-${status}`
      const context = `status ${status} with retry-after ${retryStyle} (run ${run})`

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (retryStyle === 'seconds') headers['retry-after'] = String(seconds)
      if (retryStyle === 'http-date') {
        headers['retry-after'] = new Date(Date.now() + seconds * 1_000).toUTCString()
      }
      if (idHeader !== undefined) headers[idHeader] = requestId

      const error = await failureOf(withTransportSession(
        inputOf(async () => new Response(
          '{"error":{"message":"upstream said no"}}',
          { status, headers },
        )),
        async function* (session) { yield await session.response.text() },
      ))
      const facts = factsOf(error)
      expect(facts.code, context).toBe(expectedCode)
      expect(facts.status, context).toBe(status)
      expect(facts.message, context).toBe('upstream said no')
      if (retryStyle === 'seconds') {
        expect(facts.providerRetryAfterMs, context).toBe(seconds * 1_000)
      } else if (retryStyle === 'http-date') {
        // Second resolution truncates, so the delay is bounded rather than exact.
        expect(facts.providerRetryAfterMs, context).toBeGreaterThan(0)
        expect(facts.providerRetryAfterMs, context).toBeLessThanOrEqual(seconds * 1_000)
      } else {
        expect(facts.providerRetryAfterMs, context).toBeUndefined()
      }
      expect(facts.requestId, context).toBe(idHeader === undefined ? undefined : requestId)
    }
  }, 30_000)

  it(`releases the response body on every exit path across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_38)
    const exits = ['success-unread', 'consumer-early-stop', 'decode-throws', 'caller-abort'] as const
    for (const [run, exit] of coverEvenly(rng, exits, RUNS).entries()) {
      const context = `exit ${exit} (run ${run})`
      const body = observableBody()
      const caller = new AbortController()
      const stream = withTransportSession(
        inputOf(async () => new Response(body.stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }), { signal: caller.signal }),
        async function* (_session) {
          if (exit === 'decode-throws') throw new Error('decoder gave up')
          if (exit === 'caller-abort') {
            caller.abort()
            yield 'never'
            return
          }
          // `success-unread` and `consumer-early-stop` both leave bytes behind.
          yield 'first'
          yield 'second'
        },
      )
      if (exit === 'consumer-early-stop') {
        for await (const _value of stream) break
      } else if (exit === 'success-unread') {
        await collect(stream)
      } else {
        await failureOf(stream)
      }
      expect(body.released(), `${context} left the response body unreleased`).toBe(true)
    }
  }, 30_000)
})
