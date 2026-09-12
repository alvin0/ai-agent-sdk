/**
 * Property test for the JSON pipeline's media-type and body-size guards.
 *
 * Feature: embedding-support — Property 38.
 *
 * **Validates: Requirements 13.8**
 *
 * Requirement 13.8 states two refusals and one success for `Json_Pipeline`: a
 * response whose media type is not JSON is refused, a body past the configured byte
 * bound is refused, and everything else parses. This file enumerates that whole
 * space — every media-type spelling the check has to accept or reject, and every
 * position a body can occupy relative to the bound (under, exactly at, over by a
 * declared `content-length`, over only once the bytes arrive) — and asserts the
 * invariant over randomly ordered combinations rather than one hand-picked case.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/provider-http/tests/unit/transport/json.spec.ts`. No
 * runner covers that directory: `packages/provider-http/tests/` holds fixtures only,
 * and both the package and root vitest configs collect specs out of the ROOT
 * `tests/` tree. A spec placed under the package's `tests/unit/` would never run in
 * CI, which is the one failure mode a property test must not have. It sits beside
 * `tests/unit/provider-http/transport-session-properties.spec.ts` (Properties 33-36)
 * instead, following the placement that task established.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention the
 * existing property specs established is a seeded mulberry32 generator: a failure
 * reproduces from the printed seed, and no new dependency enters the graph for
 * test-only reasons. The property runs `RUNS` generated cases, above the floor of
 * 100.
 */

import { describe, expect, it } from 'vitest'
// Core arrives through the package entry, exactly as `provider-http` imports it, so
// the error codes asserted here are the same objects the transport raised.
import { MODEL_ERROR_CODES, resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import { HTTP_PROVIDER_ERROR_CODES } from '../../../packages/provider-http/src/common/config.ts'
import type { HttpTransportConnection } from '../../../packages/provider-http/src/transport/connection.ts'
import {
  isJsonMediaType,
  JSON_MEDIA_TYPES,
  transportJson,
} from '../../../packages/provider-http/src/transport/json.ts'
import type { HttpTransportRequestInput } from '../../../packages/provider-http/src/transport/session.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases; the spec floor is 100. */
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

/** Walk a case list shuffled, so no assertion depends on enumeration order. */
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

function inputOf(
  fetch: typeof globalThis.fetch,
  limits: Partial<HttpTransportConnection> = {},
): HttpTransportRequestInput {
  return {
    displayName: 'JSON Property',
    provider: 'json-property',
    model: 'embedding-a',
    path: '/embeddings',
    accept: 'application/json',
    body: { value: { input: 'hi' }, encoded: '{"input":"hi"}', bytes: 14 },
    connection: {
      baseUrl: 'https://transport.invalid',
      headers: { 'content-type': 'application/json' },
      retryPolicy: RETRY_POLICY,
      ...limits,
      fetch,
    },
  }
}

/**
 * A body whose reads and teardown are observable, so "refused without draining the
 * body" is assertable rather than assumed.
 *
 * The pull counter has a floor of one that no consumer causes: a default
 * `ReadableStream` has a high-water mark of 1 and prefills its queue as soon as the
 * stream starts. What separates a refusal from a full read is therefore not "zero
 * pulls" but "no pull past that prefill", which is why the caller splits the body
 * across at least three chunks.
 */
function trackedBody(bytes: Uint8Array, chunks: number): {
  readonly stream: ReadableStream<Uint8Array>
  pulls: () => number
  cancelled: () => boolean
} {
  const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / chunks))
  let pulls = 0
  let cancelled = false
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize))
      offset += chunkSize
    },
    cancel() { cancelled = true },
  })
  return { stream, pulls: () => pulls, cancelled: () => cancelled }
}

const ENCODER = new TextEncoder()

/** A JSON value whose parsed shape is worth comparing, not just a fixed literal. */
function jsonValueOf(rng: Rng, run: number): unknown {
  return {
    id: `run-${run}`,
    data: Array.from({ length: intBetween(rng, 1, 3) }, (_unused, index) => ({
      index,
      embedding: Array.from({ length: intBetween(rng, 1, 4) }, () => Number(rng().toFixed(6))),
    })),
    usage: { prompt_tokens: intBelow(rng, 500) },
  }
}

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

/**
 * Media types the check must accept. `application/json` is the whole allow-list, so
 * the variation that matters is spelling: parameters, casing and padding are all
 * things a real provider sends and none of them change the media type.
 */
const ACCEPTED_CONTENT_TYPES: readonly string[] = [
  'application/json',
  'application/json; charset=utf-8',
  'APPLICATION/JSON',
  '  application/json  ',
  'application/json;charset=UTF-8;boundary=x',
]

/**
 * Media types the check must refuse. `text/event-stream` is the SSE pipeline's own
 * type and `text/html` is what a proxy outage returns; `application/json-patch+json`
 * and `application/jsonx` are the near-misses a prefix or substring check would let
 * through. A missing header is refused too: absence is not a JSON claim.
 */
const REJECTED_CONTENT_TYPES: readonly (string | null)[] = [
  'text/html',
  'text/plain',
  'text/event-stream',
  'application/xml',
  'application/json-patch+json',
  'application/jsonx',
  '',
  null,
]

/** Where a body sits relative to the configured byte bound. */
type BodyPlacement = 'under-limit' | 'at-limit' | 'declared-over-limit' | 'streamed-over-limit'

const BODY_PLACEMENTS: readonly BodyPlacement[] = [
  'under-limit',
  'at-limit',
  'declared-over-limit',
  'streamed-over-limit',
]

/** One generated case: either a media-type case or a body-size case. */
type Case = { readonly kind: 'media-type'; readonly contentType: string | null }
  | { readonly kind: 'body'; readonly placement: BodyPlacement }

const CASES: readonly Case[] = [
  ...ACCEPTED_CONTENT_TYPES.map(contentType => ({ kind: 'media-type', contentType } as const)),
  ...REJECTED_CONTENT_TYPES.map(contentType => ({ kind: 'media-type', contentType } as const)),
  ...BODY_PLACEMENTS.map(placement => ({ kind: 'body', placement } as const)),
]

interface Observation {
  /** The value the response body actually carried. */
  readonly sent: unknown
  /** The value `decode` was handed, when decoding happened at all. */
  readonly decoded: unknown
  readonly decodeCalls: number
  readonly returned: unknown
  readonly code: string | undefined
  readonly message: string
  /** Pull count, whose unavoidable floor is the queue prefill of one. */
  readonly pulls: number
  readonly cancelled: boolean
}

async function observe(testCase: Case, rng: Rng, run: number): Promise<Observation> {
  const value = jsonValueOf(rng, run)
  const encoded = JSON.stringify(value)
  const bytes = ENCODER.encode(encoded)
  const size = bytes.byteLength

  const contentType = testCase.kind === 'media-type'
    ? testCase.contentType
    : 'application/json'
  const placement: BodyPlacement = testCase.kind === 'body' ? testCase.placement : 'under-limit'

  // The bound is derived from the body that was actually generated, so "over" and
  // "under" stay true no matter how large the generated value happened to be.
  const maxResponseBytes = placement === 'at-limit'
    ? size
    : placement === 'under-limit'
      ? size + intBetween(rng, 1, 64)
      : Math.max(1, size - intBetween(rng, 1, Math.max(1, size - 1)))

  // At least three chunks, so a full read needs more pulls than the queue prefill.
  const body = trackedBody(bytes, intBetween(rng, 3, 8))
  const headers = new Headers()
  if (contentType !== null) headers.set('content-type', contentType)
  // Only the declared case advertises a length: the streamed case has to be caught
  // by the running byte total, which is also what catches a header that lies.
  if (placement === 'declared-over-limit') headers.set('content-length', String(size))

  let decoded: unknown
  let decodeCalls = 0
  let returned: unknown
  let code: string | undefined
  let message = ''
  try {
    returned = await transportJson(
      inputOf(
        async () => new Response(body.stream, { status: 200, headers }),
        { maxResponseBytes },
      ),
      (_session, parsed) => {
        decodeCalls += 1
        decoded = parsed
        return { echoed: parsed }
      },
    )
  } catch (error: unknown) {
    const record = typeof error === 'object' && error !== null
      ? error as Record<string, unknown>
      : {}
    code = typeof record.code === 'string' ? record.code : undefined
    message = typeof record.message === 'string' ? record.message : ''
  }
  return {
    sent: value,
    decoded,
    decodeCalls,
    returned,
    code,
    message,
    pulls: body.pulls(),
    cancelled: body.cancelled(),
  }
}

describe('Feature: embedding-support, Property 38: Json_Pipeline kiểm tra media type và giới hạn body', () => {
  it(`refuses non-JSON media types and over-limit bodies, and parses everything else across ${RUNS} generated cases`, async () => {
    const rng = rngOf(0x51_6e_41_38)
    for (const [run, testCase] of coverEvenly(rng, CASES, RUNS).entries()) {
      const context = testCase.kind === 'media-type'
        ? `content-type ${JSON.stringify(testCase.contentType)} (run ${run})`
        : `body ${testCase.placement} (run ${run})`
      const observed = await observe(testCase, rng, run)

      if (testCase.kind === 'media-type') {
        const accepted = isJsonMediaType(testCase.contentType)
        // The predicate and the pipeline are one decision, stated twice: whatever
        // `isJsonMediaType` says about a header is what the pipeline must do with it.
        expect(accepted, `${context} disagrees with the accept list`)
          .toBe(ACCEPTED_CONTENT_TYPES.includes(testCase.contentType ?? '\u0000'))
        if (accepted) {
          expect(observed.code, context).toBeUndefined()
          expect(observed.decodeCalls, context).toBe(1)
          expect(observed.decoded, `${context} parsed into a different value`)
            .toEqual(observed.sent)
          expect(observed.returned, context).toEqual({ echoed: observed.sent })
          continue
        }
        expect(observed.code, `${context} was not refused as a media-type failure`)
          .toBe(HTTP_PROVIDER_ERROR_CODES.JSON_MEDIA_TYPE_INVALID)
        expect(observed.message, context).toContain(JSON_MEDIA_TYPES.join(' or '))
        // Refused on headers alone: nothing parsed, nothing drained, body released.
        expect(observed.decodeCalls, context).toBe(0)
        expect(observed.pulls, `${context} drained a body it had already refused`)
          .toBeLessThanOrEqual(1)
        expect(observed.cancelled, `${context} left the response body open`).toBe(true)
        continue
      }

      if (testCase.placement === 'under-limit' || testCase.placement === 'at-limit') {
        expect(observed.code, `${context} was refused inside the bound`).toBeUndefined()
        expect(observed.decodeCalls, context).toBe(1)
        expect(observed.decoded, `${context} parsed into a different value`)
          .toEqual(observed.sent)
        expect(observed.returned, context).toEqual({ echoed: observed.sent })
        continue
      }

      // Over the bound is a transport failure on both paths, never a truncation:
      // `decode` is not offered half a document to parse.
      expect(observed.code, `${context} was not refused as a transport failure`)
        .toBe(MODEL_ERROR_CODES.TRANSPORT)
      expect(observed.message, context).toContain('-byte limit')
      expect(observed.decodeCalls, context).toBe(0)
      expect(observed.cancelled, `${context} left the response body open`).toBe(true)
      if (testCase.placement === 'declared-over-limit') {
        // The declared length is checked before the body is drained.
        expect(observed.pulls, `${context} drained a body it could have refused`)
          .toBeLessThanOrEqual(1)
      }
    }
  }, 30_000)
})
