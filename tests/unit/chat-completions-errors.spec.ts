/**
 * Cross-provider pinning of the Chat Completions error mapping.
 *
 * Feature: github-copilot-provider — Property 41.
 *
 * `packages/protocol-openai-chat-completions/src/errors.ts` REPRODUCES the
 * shared HTTP-to-taxonomy table in `packages/provider-http/src/base/http-errors.ts`
 * rather than importing it, because the protocol package may depend on `core`
 * alone (DD-10). A reproduction rots silently: someone fixes a classifier on one
 * side, the other keeps the old answer, and the same `(status, body)` pair then
 * means two different things depending on which provider took the call. This
 * spec is the pin. It drives both implementations over the same generated
 * situations and requires them to agree on the error code, the retryable flag,
 * the delay read from `retry-after`, and the provider request id.
 *
 * Two divergences are DELIBERATE and are asserted as exact, narrow exceptions
 * rather than tolerated by weakening the comparison:
 *   1. a moderation rejection at 400/422 is `UNSUPPORTED_CONTENT` here and
 *      `INVALID_REQUEST` in the shared table;
 *   2. a body carrying `{"error": "plain string"}` yields that string as the
 *      message here, where the shared parser falls back to the status.
 * Neither changes `detail`, the retryable flag, the delay, or the request id —
 * and that is exactly what the assertions below say.
 *
 * Inputs come from a SEEDED generator, not `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here.
 */

import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_ERROR_CODES,
  ModelError,
  QUOTA_EXCEEDED_CODE,
  isRetryable,
  resolveRetryPolicy,
} from '@alvin0/ai-agent-sdk-core'
import type { ProviderRequestId, ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import {
  chatCompletionsErrorCode,
  chatCompletionsHttpError,
  chatCompletionsRequestId,
  chatCompletionsRetryAfterMs,
  parseChatCompletionsErrorBody,
} from '../../packages/protocol-openai-chat-completions/src/errors.ts'
// The existing-provider side of the comparison. Imported as a single source
// file rather than through the `provider-http` package entry: the entry pulls
// the whole adapter graph, and the table under comparison is self-contained.
import {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
} from '../../packages/provider-http/src/base/http-errors.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

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

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

// ---------------------------------------------------------------------------
// The shared situation set
// ---------------------------------------------------------------------------

/**
 * Statuses that actually decide something, plus two that decide nothing.
 *
 * 409 and 418 are in the list on purpose: they fall through every branch to the
 * `HTTP_{status}` residual, and the residual is as much part of the contract as
 * the classified buckets. Everything stays inside 100–599 because `ModelError`
 * validates the range.
 */
const STATUSES = [400, 401, 403, 404, 408, 409, 413, 418, 422, 429, 500, 502, 503, 529] as const

/** Wording families the classifiers must separate, each with its own outcome. */
const WORDING = {
  /** Nothing to classify: the status alone must decide. */
  neutral: [
    'invalid_request_error',
    'the upstream gateway closed the connection',
    'model is currently overloaded',
    'unexpected end of JSON input',
    // Near-misses for the narrow classifiers: "too long" without naming the
    // context window, and a quota word with no exhaustion verb attached.
    'your message is too long',
    'quota information is unavailable',
  ],
  quota: [
    'insufficient_quota',
    'You exceeded your current quota, please check your plan and billing details',
    'usage limit reached for this billing period',
    'out of credits',
    'balance exhausted',
  ],
  context: [
    'context_length_exceeded',
    "This model's maximum context length is 8192 tokens, however you requested 9001",
    'prompt is too long for this model',
    'the input exceeds the model context window',
  ],
  filter: [
    'content_filter',
    'content policy violation detected in the prompt',
    'blocked by the responsible AI policy',
    'content_filtered',
  ],
} as const

type WordingKind = keyof typeof WORDING

/** Body shapes seen on this wire, including the ones that are not JSON at all. */
type BodyShape = 'canonical' | 'bare' | 'detail' | 'nested-detail' | 'bare-error-string' | 'html' | 'empty'

const BODY_SHAPES: readonly BodyShape[] = [
  'canonical',
  'bare',
  'detail',
  'nested-detail',
  'bare-error-string',
  'html',
  'empty',
]

/** One generated failure situation, kept as data so a seed fully describes it. */
interface Situation {
  readonly status: number
  readonly body: string
  readonly headers: Headers
  /** Present so assertions can name the deliberate divergences precisely. */
  readonly shape: BodyShape
  readonly wording: WordingKind
  /** `retry-after` was given as an HTTP date, so the delay is clock-dependent. */
  readonly delayFromDate: boolean
}

function bodyOf(shape: BodyShape, phrase: string, rng: Rng): string {
  switch (shape) {
    case 'canonical':
      return JSON.stringify({
        error: {
          ...bool(rng) ? { code: phrase.split(' ')[0] } : {},
          type: 'invalid_request_error',
          message: phrase,
        },
      })
    case 'bare':
      return JSON.stringify({ type: 'error', message: phrase })
    case 'detail':
      // The FastAPI convention some compatible endpoints use.
      return JSON.stringify({ detail: phrase })
    case 'nested-detail':
      return JSON.stringify({ error: { detail: phrase } })
    case 'bare-error-string':
      return JSON.stringify({ error: phrase })
    case 'html':
      return `<html><head><title>502</title></head><body><h1>${phrase}</h1></body></html>`
    default:
      return ''
  }
}

/** `retry-after` values covering both defined forms plus the unusable ones. */
function applyRetryAfter(headers: Headers, rng: Rng): boolean {
  switch (pick(rng, ['absent', 'seconds', 'zero', 'padded', 'future-date', 'past-date', 'junk'] as const)) {
    case 'seconds': {
      headers.set('retry-after', String(1 + intBelow(rng, 120)))
      return false
    }
    case 'zero': {
      // A zero delay must read as "no usable delay", not as a zero-length wait.
      headers.set('retry-after', '0')
      return false
    }
    case 'padded': {
      headers.set('retry-after', `  ${String(1 + intBelow(rng, 30))}  `)
      return false
    }
    case 'future-date': {
      headers.set('retry-after', new Date(Date.now() + 5_000 + intBelow(rng, 60_000)).toUTCString())
      return true
    }
    case 'past-date': {
      headers.set('retry-after', new Date(Date.now() - 60_000).toUTCString())
      return true
    }
    case 'junk': {
      headers.set('retry-after', pick(rng, ['soon', '-5', '3.5s', ''] as const))
      return false
    }
    default:
      return false
  }
}

/** Correlation-id headers, in and out of priority order, some empty, plus a decoy. */
function applyRequestId(headers: Headers, rng: Rng): void {
  const names = ['request-id', 'x-request-id', 'x-requestid', 'cf-ray', 'x-correlation-id'] as const
  for (const name of names) {
    if (!bool(rng)) continue
    // An empty value must not be mistaken for an id.
    headers.set(name, bool(rng) ? '' : `${name}-${String(intBelow(rng, 100_000))}`)
  }
}

function generateSituation(rng: Rng): Situation {
  const status = pick(rng, STATUSES)
  const wording = pick(rng, ['neutral', 'neutral', 'quota', 'context', 'filter'] as const)
  const shape = pick(rng, BODY_SHAPES)
  const headers = new Headers()
  const delayFromDate = applyRetryAfter(headers, rng)
  applyRequestId(headers, rng)
  return {
    status,
    body: bodyOf(shape, pick(rng, WORDING[wording]), rng),
    headers,
    shape,
    wording,
    delayFromDate,
  }
}

// ---------------------------------------------------------------------------
// The existing-provider reference
// ---------------------------------------------------------------------------

/** Default policy: what decides retryability is policy, never the adapter. */
const POLICY: ResolvedRetryPolicy = resolveRetryPolicy(undefined, 'test.retry')

/** Whether a first retry is admitted for a code under the default policy. */
function retryable(code: string): boolean {
  return isRetryable(POLICY, code, 0)
}

/**
 * What an existing provider produces for a situation, via the shared table.
 *
 * Mirrors `HttpAdapter.httpFailure` — same helpers, same order, same fallback
 * message — so the comparison is against real provider behaviour rather than
 * against a restatement of it.
 */
function referenceFailure(situation: Situation, displayName: string, url: string): {
  readonly code: string
  readonly message: string
  readonly detail: string
  readonly delay: number | undefined
  readonly id: ProviderRequestId | undefined
} {
  const { message, detail } = parseErrorBody(situation.body)
  return {
    code: httpErrorCode(situation.status, detail),
    message: message ?? `${displayName} error (HTTP ${String(situation.status)}) from ${url}`,
    detail,
    delay: retryAfterMs(situation.headers.get('retry-after')),
    id: requestIdFrom(situation.headers),
  }
}

/**
 * Compare two delays read from the same header.
 *
 * The delta-seconds form is a pure function of the header and must match
 * exactly. The HTTP-date form subtracts `Date.now()`, so the two reads are taken
 * microseconds apart and can legitimately differ by a millisecond or two; what
 * must still match exactly is whether a usable delay was found at all.
 */
function expectSameDelay(
  actual: number | undefined,
  expected: number | undefined,
  fromDate: boolean,
  trace: string,
): void {
  expect(actual === undefined, `${trace} delay presence`).toBe(expected === undefined)
  if (actual === undefined || expected === undefined) return
  if (fromDate) expect(Math.abs(actual - expected), `${trace} delay drift`).toBeLessThanOrEqual(250)
  else expect(actual, `${trace} delay`).toBe(expected)
}

// ---------------------------------------------------------------------------
// Property 41
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 41: Cùng tình huống lỗi cho cùng error code ở mọi provider', () => {
  it('agrees with an existing provider on code, retryable, retry-after delay, and request id', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const situation = generateSituation(rng)
      const displayName = 'Test Provider'
      const url = 'https://example.invalid/v1/chat/completions'
      const reference = referenceFailure(situation, displayName, url)
      const parsed = parseChatCompletionsErrorBody(situation.body)
      const code = chatCompletionsErrorCode(situation.status, parsed.detail)
      const trace = `seed ${String(seed)} status ${String(situation.status)} `
        + `${situation.shape}/${situation.wording}`

      // The classifier INPUT is held byte-identical. Everything downstream is
      // decided from `detail`, so if the two parsers ever disagree about it the
      // codes can drift even while both tables look correct in isolation.
      expect(parsed.detail, `${trace} detail`).toBe(reference.detail)

      // The one sanctioned code divergence, stated as an equality rather than
      // as a skip: moderation wording inside a request-rejected status.
      const moderation = (situation.status === 400 || situation.status === 422)
        && reference.code === MODEL_ERROR_CODES.INVALID_REQUEST
        && WORDING.filter.some(phrase => parsed.detail.includes(phrase))
      const expectedCode = moderation ? MODEL_ERROR_CODES.UNSUPPORTED_CONTENT : reference.code
      expect(code, `${trace} code`).toBe(expectedCode)

      // Retryability is what the caller actually acts on, and it must agree
      // even where the codes deliberately differ — a filtered prompt and a
      // malformed request are both hopeless to repeat.
      expect(retryable(code), `${trace} retryable`).toBe(retryable(reference.code))

      expectSameDelay(
        chatCompletionsRetryAfterMs(situation.headers.get('retry-after')),
        reference.delay,
        situation.delayFromDate,
        trace,
      )
      expect(chatCompletionsRequestId(situation.headers), `${trace} request id`)
        .toBe(requestIdFrom(situation.headers))

      // And the same agreement through the assembled error, which is what a
      // caller sees. `providerRetryAfterMs` is compared separately above
      // because of the clock-dependent date form.
      const error = chatCompletionsHttpError({
        status: situation.status,
        body: situation.body,
        headers: situation.headers,
        displayName,
        url,
      })
      expect(error, trace).toBeInstanceOf(ModelError)
      expect(error.code, `${trace} error code`).toBe(expectedCode)
      expect(error.failure.status, `${trace} status`).toBe(situation.status)
      expect(error.failure.requestId, `${trace} failure request id`).toBe(reference.id)
      expectSameDelay(
        error.failure.providerRetryAfterMs,
        reference.delay,
        situation.delayFromDate,
        `${trace} failure`,
      )

      // The second sanctioned divergence: a bare-string `error` body is a
      // message the shared parser drops. It changes the message only.
      if (situation.shape === 'bare-error-string' && situation.body.length > 0) {
        expect(parsed.message, `${trace} bare message`)
          .toBe((JSON.parse(situation.body) as { error: string }).error)
      } else {
        expect(error.message, `${trace} message`).toBe(reference.message)
      }
    }
  })

  it('classifies the shared situation set identically for every status, wording, and body shape', () => {
    // The generator is random-ish; this walks the full cross product so no
    // (status, wording, shape) combination can be missed by sampling luck.
    let divergences = 0
    for (const status of STATUSES) {
      for (const wording of Object.keys(WORDING) as WordingKind[]) {
        for (const phrase of WORDING[wording]) {
          for (const shape of BODY_SHAPES) {
            const body = bodyOf(shape, phrase, rngOf(7))
            const mine = parseChatCompletionsErrorBody(body)
            const shared = parseErrorBody(body)
            const trace = `${String(status)} ${shape} ${wording} "${phrase}"`

            expect(mine.detail, `${trace} detail`).toBe(shared.detail)
            const sharedCode = httpErrorCode(status, shared.detail)
            const mineCode = chatCompletionsErrorCode(status, mine.detail)
            const moderation = (status === 400 || status === 422)
              && wording === 'filter'
              && sharedCode === MODEL_ERROR_CODES.INVALID_REQUEST
              && mine.detail.length > 0
            expect(mineCode, `${trace} code`)
              .toBe(moderation ? MODEL_ERROR_CODES.UNSUPPORTED_CONTENT : sharedCode)
            expect(retryable(mineCode), `${trace} retryable`).toBe(retryable(sharedCode))
            if (moderation) divergences += 1
          }
        }
      }
    }
    // Guards the comparison against passing vacuously: if the moderation branch
    // were deleted from either side, the loop above would still agree
    // everywhere unless the divergent cases are known to be reached.
    expect(divergences).toBeGreaterThan(0)
  })

  it('keeps the terminal buckets out of the retryable set on both sides', () => {
    // A spot check on the codes whose retry behaviour is the whole point of the
    // wording classifiers: getting these wrong costs money, not just latency.
    for (const code of [QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, MODEL_ERROR_CODES.AUTH,
      MODEL_ERROR_CODES.INVALID_REQUEST, MODEL_ERROR_CODES.UNSUPPORTED_CONTENT]) {
      expect(retryable(code), code).toBe(false)
    }
    for (const code of [MODEL_ERROR_CODES.RATE_LIMIT, MODEL_ERROR_CODES.SERVER]) {
      expect(retryable(code), code).toBe(true)
    }

    const quota = JSON.stringify({ error: { code: 'insufficient_quota', message: 'no balance' } })
    const detail = parseChatCompletionsErrorBody(quota).detail
    expect(chatCompletionsErrorCode(429, detail)).toBe(httpErrorCode(429, detail))
    expect(chatCompletionsErrorCode(429, detail)).toBe(QUOTA_EXCEEDED_CODE)
  })
})
