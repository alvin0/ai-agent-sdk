/**
 * Cross-provider pinning of the error mapping at the HARNESS layer.
 *
 * Feature: github-copilot-provider — Property 41, second run.
 *
 * **Validates: Requirements 10.6, 13.5, 15.5**
 *
 * `tests/unit/chat-completions-errors.spec.ts` runs the same property one layer
 * down: it compares `Chat_Completions_Protocol`'s reproduction of the error table
 * against the shared table in `packages/provider-http/src/base/http-errors.ts`,
 * both standing alone as pure functions. That run cannot see anything the
 * ASSEMBLY does. This one drives a fully built `copilotAdapter` — credential
 * store, token exchange, dual protocol, the redacting transport wrapper, the
 * `errorCode` hook — and a fully built existing provider adapter, over the same
 * generated `(status, body, headers)` situations, and requires the `ModelError`
 * each produces to agree on:
 *
 *   - the error code,
 *   - the retryable flag the caller acts on,
 *   - the delay read from `retry-after`,
 *   - the provider request id.
 *
 * Same property, two subjects. The pairing matters because the assembly has two
 * chances to break the agreement that the protocol layer never sees: the Copilot
 * transport REBUILDS a non-success `Response` (to redact tokens out of the body),
 * so a header it forgot to copy would silently drop a `retry-after` or a request
 * id; and the `errorCode` hook could widen past the one case it owns.
 *
 * The existing-provider side is `openAiAdapter`, driven the same way — an
 * injected `fetch`, an advisory catalog, one streaming call. It is a real adapter
 * on the shared `provider-http` error mapping rather than a restatement of the
 * table, which is the point: if someone changes `httpErrorCode`, both sides move
 * together and this spec stays green; if someone changes it for one provider
 * only, this spec fails.
 *
 * ## The one deliberate divergence, and how it is asserted
 *
 * A 400 whose body carries the missing-editor-header signature becomes
 * `COPILOT_EDITOR_HEADERS_MISSING` instead of `INVALID_REQUEST` (Requirement
 * 2.5). It is asserted as an EXACT, NARROW exception — an equality against a
 * predicted code, plus a count proving the divergent branch is actually reached —
 * rather than by weakening the comparison. Every other 400 keeps the shared
 * classification, the retryable flag agrees even where the codes differ, and the
 * delay and the request id agree in every case including this one.
 *
 * The protocol-layer run documents two divergences of its own (moderation
 * wording, and a bare-string `error` body). Neither appears here: at the harness
 * layer both providers go through the same shared parser and the same shared
 * table, so those two are structurally impossible in this comparison. The
 * situation generator below still carries the wording families and body shapes
 * that produce them, so the claim is tested rather than assumed.
 *
 * Inputs come from a SEEDED generator, not `Math.random`, so a failure reproduces
 * from the printed seed. The repository carries no property-testing library, so
 * the generators live here, following the structure the protocol-layer run
 * established.
 */

import {
  createTextMessage,
  isRetryable,
  MODEL_ERROR_CODES,
  ModelError,
  resolveRetryPolicy,
  type ProviderRequestId,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { HttpModelAdapter, ProviderCatalogModel } from '@alvin0/ai-agent-sdk-provider-http'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_ERROR_CODES,
  copilotAdapter,
  memoryCopilotCredentialStore,
} from '../../packages/provider-copilot/src/index.ts'
import { openAiAdapter } from '../../packages/provider-openai/src/index.ts'
// The Copilot harness data: the model id both endpoint passes share, the two
// router pins, the long-lived credential, and the responder that answers the
// token exchange so a scripted fetch only has to script the generation leg.
import {
  COPILOT_CONFORMANCE_GITHUB_TOKEN,
  COPILOT_CONFORMANCE_MODEL,
  COPILOT_GENERATION_RUNS,
  COPILOT_TOKEN_EXCHANGE_PATH,
  withCopilotTokenExchange,
  type CopilotConformanceEndpoint,
} from '../../packages/testkit/src/index.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated situations; the spec floor is 100. */
const RUNS = 100

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
 * Statuses that decide something, plus two that decide nothing.
 *
 * 409 and 418 fall through every branch to the `HTTP_{status}` residual, and the
 * residual is as much part of the contract as the classified buckets. The same
 * list the protocol-layer run uses, so the two runs are comparable.
 */
const STATUSES = [400, 401, 403, 404, 408, 409, 413, 418, 422, 429, 500, 502, 503, 529] as const

/**
 * Wording families the classifiers must separate.
 *
 * `editor` is the family the protocol-layer run does not have: it is the input
 * that reaches the one hook the Copilot assembly adds, in the several spellings
 * the endpoint has been seen to use. Everything else is carried over unchanged so
 * the two runs cover the same wording space.
 */
const WORDING = {
  /** Nothing to classify: the status alone must decide. */
  neutral: [
    'invalid_request_error',
    'the upstream gateway closed the connection',
    'model is currently overloaded',
    'unexpected end of JSON input',
    // Near-misses for the narrow classifiers.
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
  editor: [
    'missing required header Editor-Version',
    'Editor-Plugin-Version is required',
    'editor_version header not recognized',
    'editor plugin version must be supplied',
    'the editor header is absent',
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
  /** Present so assertions and traces can name the case precisely. */
  readonly shape: BodyShape
  readonly wording: WordingKind
  /** The exact phrase placed in the body. */
  readonly phrase: string
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
  const wording = pick(rng, ['neutral', 'quota', 'context', 'filter', 'editor', 'editor'] as const)
  const shape = pick(rng, BODY_SHAPES)
  const phrase = pick(rng, WORDING[wording])
  const headers = new Headers()
  const delayFromDate = applyRetryAfter(headers, rng)
  applyRequestId(headers, rng)
  // A stale content-length would fail the bounded read that follows, and the
  // Copilot transport is the layer that has to notice. Set it so that noticing is
  // required rather than incidental.
  headers.set('content-type', shape === 'html' ? 'text/html' : 'application/json')
  return { status, body: bodyOf(shape, phrase, rng), headers, shape, wording, phrase, delayFromDate }
}

/**
 * Whether this situation is the one case the Copilot assembly reclassifies.
 *
 * Bounded to 400 and to a body that actually carries the signature: the `empty`
 * shape drops the phrase entirely, and a signature nobody can read is a plain bad
 * request. Derived from the generated situation rather than from a second copy of
 * the source predicate, so this spec cannot agree with a broken predicate by
 * sharing its bug.
 */
function isEditorSignature(situation: Situation): boolean {
  return situation.status === 400
    && situation.wording === 'editor'
    && situation.body.includes(situation.phrase)
}

// ---------------------------------------------------------------------------
// Driving both assembled adapters
// ---------------------------------------------------------------------------

/** Registry route ids; distinct so a trace names the subject unambiguously. */
const COPILOT_ROUTE = 'copilot'
const REFERENCE_ROUTE = 'openai'

/** Endpoint bases, kept off any real origin. Nothing here may reach the network. */
const COPILOT_BASE = 'https://copilot.invalid/api'
const REFERENCE_BASE = 'https://reference.invalid/v1'

/**
 * The advisory catalog both adapters get.
 *
 * Supplied so DISCOVERY NEVER RUNS: a `/models` call would be a second dispatch
 * per iteration, and the failure under comparison is the generation one.
 */
const CATALOG: readonly ProviderCatalogModel[] = Object.freeze([
  { id: COPILOT_CONFORMANCE_MODEL, contextWindow: 8_192, maxTokens: 1_024 },
])

/** The two router pins the harness declares, read off the shared generation runs. */
const ENDPOINTS: readonly CopilotConformanceEndpoint[] = Object.freeze(
  COPILOT_GENERATION_RUNS.map(run => run.endpoint),
)

/** What a scripted deployment recorded, so a message can be checked exactly. */
interface Scripted {
  readonly impl: typeof globalThis.fetch
  /** URLs of the generation dispatches, in order. The exchange is not one. */
  readonly urls: readonly string[]
}

/**
 * A `fetch` answering every generation request with the same situation.
 *
 * A fresh `Response` per call, because a body is consumed once and both endpoint
 * passes dispatch separately.
 */
function scripted(situation: Situation): Scripted {
  const urls: string[] = []
  const impl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input)
    urls.push(url)
    return Promise.resolve(new Response(
      situation.body.length === 0 ? null : situation.body,
      { status: situation.status, headers: new Headers(situation.headers) },
    ))
  }) as typeof globalThis.fetch
  return { impl, urls }
}

function copilotFor(endpoint: CopilotConformanceEndpoint, fetchImpl: typeof globalThis.fetch): HttpModelAdapter {
  return copilotAdapter({
    authStore: memoryCopilotCredentialStore({
      version: 1,
      github: { token: COPILOT_CONFORMANCE_GITHUB_TOKEN },
    }),
    baseUrl: COPILOT_BASE,
    models: CATALOG,
    endpointOverrides: { [COPILOT_CONFORMANCE_MODEL]: endpoint },
    id: COPILOT_ROUTE,
    fetch: withCopilotTokenExchange(fetchImpl),
  })
}

function referenceFor(fetchImpl: typeof globalThis.fetch): HttpModelAdapter {
  return openAiAdapter({
    apiKey: 'reference-provider-api-key',
    baseUrl: REFERENCE_BASE,
    models: CATALOG,
    fetch: fetchImpl,
  })
}

/** Run one generation and return the failure it raised. */
async function failureOf(adapter: HttpModelAdapter, route: string, trace: string): Promise<ModelError> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      provider: route,
      model: COPILOT_CONFORMANCE_MODEL,
      messages: [createTextMessage('xin chào')],
    })) chunks.push(chunk)
  } catch (error: unknown) {
    expect(error, `${trace} ${route} failure type`).toBeInstanceOf(ModelError)
    return error as ModelError
  }
  throw new Error(`${trace} ${route} produced ${String(chunks.length)} chunks instead of failing`)
}

/** One subject's answer, reduced to the four facts the property compares. */
interface Answer {
  readonly code: string
  readonly retryable: boolean
  readonly delay: number | undefined
  readonly requestId: ProviderRequestId | undefined
  readonly status: number | undefined
  readonly message: string
  /** Where the failing request was sent; the fallback message names it. */
  readonly url: string
}

async function answerOf(
  adapter: HttpModelAdapter,
  route: string,
  deployment: Scripted,
  trace: string,
): Promise<Answer> {
  const error = await failureOf(adapter, route, trace)
  const url = deployment.urls.at(-1)
  expect(url, `${trace} ${route} dispatched`).toBeTypeOf('string')
  return {
    code: error.code,
    retryable: retryable(error.code),
    delay: error.failure.providerRetryAfterMs,
    requestId: error.failure.requestId,
    status: error.failure.status,
    message: error.message,
    url: url ?? '',
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Default policy: what decides retryability is policy, never the adapter. */
const POLICY: ResolvedRetryPolicy = resolveRetryPolicy(undefined, 'test.retry')

/** Whether a first retry is admitted for a code under the default policy. */
function retryable(code: string): boolean {
  return isRetryable(POLICY, code, 0)
}

/**
 * Compare two delays read from the same header.
 *
 * The delta-seconds form is a pure function of the header and must match
 * exactly. The HTTP-date form subtracts `Date.now()`, and the two adapters read
 * it milliseconds apart, so a small drift is legitimate; what must still match
 * exactly is whether a usable delay was found at all.
 */
function expectSameDelay(
  actual: number | undefined,
  expected: number | undefined,
  fromDate: boolean,
  trace: string,
): void {
  expect(actual === undefined, `${trace} delay presence`).toBe(expected === undefined)
  if (actual === undefined || expected === undefined) return
  if (fromDate) expect(Math.abs(actual - expected), `${trace} delay drift`).toBeLessThanOrEqual(1_000)
  else expect(actual, `${trace} delay`).toBe(expected)
}

// ---------------------------------------------------------------------------
// Smoke: the two subjects really are assembled and really do dispatch
// ---------------------------------------------------------------------------

describe('Copilot cross-provider error harness', () => {
  it('drives both Copilot endpoints and the reference provider through one exchange each', async () => {
    const situation: Situation = {
      status: 503,
      body: JSON.stringify({ error: { message: 'model is currently overloaded' } }),
      headers: new Headers({ 'retry-after': '7', 'request-id': 'smoke-1' }),
      shape: 'canonical',
      wording: 'neutral',
      phrase: 'model is currently overloaded',
      delayFromDate: false,
    }
    const paths: string[] = []
    const record = (url: string): void => { paths.push(new URL(url).pathname) }

    for (const endpoint of ENDPOINTS) {
      const deployment = scripted(situation)
      const seen: string[] = []
      const wrapped = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        seen.push(new URL(String(input instanceof Request ? input.url : input)).pathname)
        return deployment.impl(input, init)
      }) as typeof globalThis.fetch
      const adapter = copilotFor(endpoint, wrapped)
      // `withCopilotTokenExchange` wraps `wrapped`, so the exchange is answered
      // before `wrapped` ever sees it; `seen` therefore holds the generation legs.
      const error = await failureOf(adapter, COPILOT_ROUTE, 'smoke')
      expect(error.code, endpoint).toBe(MODEL_ERROR_CODES.SERVER)
      expect(seen, endpoint).toHaveLength(1)
      expect(seen.every(path => !path.includes(COPILOT_TOKEN_EXCHANGE_PATH)), endpoint).toBe(true)
      for (const url of deployment.urls) record(url)
    }

    const deployment = scripted(situation)
    const error = await failureOf(referenceFor(deployment.impl), REFERENCE_ROUTE, 'smoke')
    expect(error.code).toBe(MODEL_ERROR_CODES.SERVER)
    for (const url of deployment.urls) record(url)

    // Both Copilot endpoints and the reference endpoint were genuinely reached:
    // a comparison run entirely on one path would prove nothing about the other.
    expect(new Set(paths)).toEqual(new Set(['/api/responses', '/api/chat/completions', '/v1/responses']))
  })
})

// ---------------------------------------------------------------------------
// Property 41
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 41: Cùng tình huống lỗi cho cùng error code ở mọi provider', () => {
  it('agrees with an existing provider on code, retryable, retry-after delay, and request id', async () => {
    // Counted rather than assumed: the divergent branch, and the shapes that
    // produce the protocol layer's own two divergences, all have to be reached
    // or the agreement below could be passing vacuously.
    let editorDivergences = 0
    let sharedClassifications = 0
    const shapes = new Set<BodyShape>()
    const codes = new Set<string>()

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const situation = generateSituation(rng)
      const base = `seed ${String(seed)} status ${String(situation.status)} `
        + `${situation.shape}/${situation.wording}`
      shapes.add(situation.shape)

      const referenceDeployment = scripted(situation)
      const reference = await answerOf(
        referenceFor(referenceDeployment.impl),
        REFERENCE_ROUTE,
        referenceDeployment,
        base,
      )
      codes.add(reference.code)

      // The SAME situation, byte for byte, through the assembled Copilot adapter
      // on both of its endpoints. Two wire protocols, one error contract.
      for (const endpoint of ENDPOINTS) {
        const trace = `${base} /${endpoint}`
        const deployment = scripted(situation)
        const subject = await answerOf(copilotFor(endpoint, deployment.impl), COPILOT_ROUTE, deployment, trace)

        // The one sanctioned divergence, stated as an equality against a
        // predicted code rather than as a skip.
        const editor = isEditorSignature(situation)
        const expectedCode = editor ? COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING : reference.code
        expect(subject.code, `${trace} code`).toBe(expectedCode)
        if (editor) {
          editorDivergences += 1
          // Narrow in both directions: the reference must be the code the
          // exception replaces, so a widened hook cannot hide here.
          expect(reference.code, `${trace} reference code`).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)
          // A diagnosis naming one header sends the reader to one fix.
          expect(subject.message, `${trace} diagnosis`).toContain('Editor-Version')
          expect(subject.message, `${trace} diagnosis`).toContain('Editor-Plugin-Version')
          expect(subject.message, `${trace} diagnosis`).toContain('editorHeaders')
          // The endpoint's own words are kept as evidence, not replaced.
          expect(subject.message, `${trace} evidence`).toContain(situation.phrase)
        } else {
          sharedClassifications += 1
          expect(subject.message, `${trace} not relabelled`).not.toContain('editorHeaders')
        }

        // Retryability is what the caller acts on, and it must agree even where
        // the codes deliberately differ: an unaccepted editor header and a
        // malformed request are both hopeless to repeat unchanged.
        expect(subject.retryable, `${trace} retryable`).toBe(reference.retryable)

        // The transport rebuilds a non-success response to redact tokens out of
        // the body. These three assertions are what makes that rebuild safe: a
        // header it failed to carry over would drop a delay or an id here.
        expectSameDelay(subject.delay, reference.delay, situation.delayFromDate, trace)
        expect(subject.requestId, `${trace} request id`).toBe(reference.requestId)
        expect(subject.status, `${trace} status`).toBe(reference.status)
        expect(subject.status, `${trace} status value`).toBe(situation.status)
      }
    }

    expect(editorDivergences, 'editor-signature cases reached').toBeGreaterThan(0)
    expect(sharedClassifications, 'shared-classification cases reached').toBeGreaterThan(0)
    // Both protocol-layer divergence sources are present in this run's inputs:
    // `bare-error-string` is the body shape whose message the shared parser
    // drops, and the moderation codes come from the `filter` wording family.
    expect(shapes.has('bare-error-string'), 'bare-string error bodies reached').toBe(true)
    expect(codes.size, 'distinct reference codes').toBeGreaterThan(3)
  })

  it('carries the provider-authored message identically wherever the body supplies one', async () => {
    // The message is the one field the two subjects may legitimately differ on:
    // with no message in the body each falls back to its own display name and
    // its own URL. So the claim is split — supplied messages must be identical,
    // and an absent one must produce each provider's own fallback and nothing
    // else. Anything vaguer would let a swallowed provider message pass.
    let supplied = 0
    let fallbacks = 0
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(0x41_00_00 + seed)
      const situation = generateSituation(rng)
      if (isEditorSignature(situation)) continue
      const trace = `seed ${String(seed)} ${situation.shape}/${situation.wording}`

      const referenceDeployment = scripted(situation)
      const reference = await answerOf(
        referenceFor(referenceDeployment.impl),
        REFERENCE_ROUTE,
        referenceDeployment,
        trace,
      )
      const endpoint = ENDPOINTS[seed % ENDPOINTS.length] ?? 'chat-completions'
      const deployment = scripted(situation)
      const subject = await answerOf(copilotFor(endpoint, deployment.impl), COPILOT_ROUTE, deployment, trace)

      // The fallback names the ORIGIN, not the full request URL: `httpFailure`
      // is handed the connection's origin, which is the part a reader needs to
      // tell one deployment of the same protocol from another.
      const fallbackOf = (name: string, url: string): string =>
        `${name} error (HTTP ${String(situation.status)}) from ${new URL(url).origin}`
      if (reference.message === fallbackOf('OpenAI', reference.url)) {
        fallbacks += 1
        expect(subject.message, `${trace} fallback`)
          .toBe(fallbackOf('GitHub Copilot', subject.url))
      } else {
        supplied += 1
        expect(subject.message, `${trace} message`).toBe(reference.message)
      }
    }
    expect(supplied, 'supplied-message cases reached').toBeGreaterThan(0)
    expect(fallbacks, 'fallback-message cases reached').toBeGreaterThan(0)
  })

  it('keeps the reclassification bounded to status 400 across the whole wording family', async () => {
    // The generator samples; this walks the editor wording family against every
    // status, so no non-400 status can be reclassified by sampling luck. It is
    // the exactness half of "narrow exception": the previous test proves the
    // divergence happens, this one proves it happens nowhere else.
    for (const status of STATUSES) {
      for (const phrase of WORDING.editor) {
        const situation: Situation = {
          status,
          body: JSON.stringify({ error: { message: phrase } }),
          headers: new Headers({ 'content-type': 'application/json' }),
          shape: 'canonical',
          wording: 'editor',
          phrase,
          delayFromDate: false,
        }
        const trace = `${String(status)} "${phrase}"`
        const referenceDeployment = scripted(situation)
        const reference = await answerOf(
          referenceFor(referenceDeployment.impl),
          REFERENCE_ROUTE,
          referenceDeployment,
          trace,
        )
        const deployment = scripted(situation)
        const subject = await answerOf(copilotFor('chat-completions', deployment.impl), COPILOT_ROUTE, deployment, trace)

        expect(subject.code, `${trace} code`).toBe(
          status === 400 ? COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING : reference.code,
        )
        expect(subject.retryable, `${trace} retryable`).toBe(reference.retryable)
      }
    }
  })
})
