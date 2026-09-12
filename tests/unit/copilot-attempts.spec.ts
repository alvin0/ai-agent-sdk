/**
 * Property test for Copilot attempt accounting.
 *
 * Feature: github-copilot-provider — Property 51.
 *
 * **Validates: Requirements 14.1**
 *
 * A `Provider_Attempt` is defined by the requirements as ONE HTTP call to the
 * provider, retries included. So the property is an equality between two things
 * that are counted independently: how many times the injected `fetch` was
 * dispatched at the Copilot surface, and how many attempt-level observation
 * records the call produced. One record per dispatch, closed exactly once, with
 * a `dispatchState` that says where the failure landed.
 *
 * ## Why the real runtime rather than a hand-built context
 *
 * The records are not something this package writes: `copilotAdapter` is built on
 * `createRuntimeHttpProvider`, which calls `context.startProviderAttempt` and
 * `attempt.end` — the SDK's existing mechanism (Requirement 14.1). Counting them
 * therefore means running the real path: `ModelRegistry` opens the model call and
 * emits `sdk.provider.attempt` events into an `ObservationPort` this file keeps,
 * and `withRetry` produces the retries. A hand-rolled `startProviderAttempt`
 * double would count what this test told it to count.
 *
 * Retries live in `withRetry`, not in the adapter: one `stream()` call is one
 * physical attempt, and the decorator re-dispatches. That is exactly why the
 * property is worth stating — the ledger has to add up ACROSS the layer boundary,
 * with the attempt numbers of one logical call running 1..n without a gap.
 *
 * ## Two lenses, because one of them cannot see a double close
 *
 * `attempt.end` in core is idempotent: a second call returns the first report and
 * captures nothing. So "closed exactly once" is invisible from the event stream —
 * a provider closing twice would look identical. A decorator adapter therefore
 * sits between `withRetry` and the Copilot adapter and wraps the context, counting
 * RAW `startProviderAttempt` and `end` invocations before core's dedup sees them.
 * The event stream proves the accounting; the raw counters prove the adapter did
 * not close twice.
 *
 * Inputs come from a SEEDED mulberry32 generator rather than `Math.random`: the
 * repository carries no property-testing library, and a failure has to reproduce
 * from the printed seed. Same shape as `tests/unit/copilot-token-cache.spec.ts`.
 */

import {
  createCoreSpan,
  createTextMessage,
  ModelAdapter,
  ModelRegistry,
  withRetry,
  type CaptureReceipt,
  type GenerateOptions,
  type ModelInfo,
  type ModelInvocationContext,
  type ObservationEvent,
  type ObservationPort,
  type ProviderAttemptHandle,
  type ProviderInfo,
  type ResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type {
  EndProviderAttemptInput,
  PreparedAdapterCall,
} from '@alvin0/ai-agent-sdk-core/provider'
import { describe, expect, it } from 'vitest'
import {
  copilotAdapter,
  memoryCopilotCredentialStore,
  type CopilotAuthFile,
} from '../../packages/provider-copilot/src/index.ts'

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

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

// ---------------------------------------------------------------------------
// The scripted outcome of one physical attempt
// ---------------------------------------------------------------------------

/**
 * What the surface does on one dispatch.
 *
 * The three kinds are the three POSITIONS a failure can occupy relative to the
 * dispatch, which is what `dispatchState` reports: `throw` fails with no response
 * ever arriving (`unknown` — the request may or may not have reached the server),
 * while a status and a stream both mean bytes came back (`sent`).
 */
type Step =
  /** A complete SSE stream: the attempt succeeds. */
  | { readonly kind: 'stream' }
  /** A non-2xx response: the attempt fails after dispatch. */
  | { readonly kind: 'status'; readonly status: number }
  /** The transport itself fails: no response, no status. */
  | { readonly kind: 'throw' }

/** Statuses the retry decorator will re-dispatch after. */
const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503]

/** A retryable step: something `withRetry` is willing to try again. */
function retryableStep(rng: Rng): Step {
  return rng() < 0.25
    ? { kind: 'throw' }
    : { kind: 'status', status: pick(rng, RETRYABLE_STATUSES) }
}

/**
 * A terminal step: the last physical attempt of a logical call.
 *
 * `exhausted` — a retryable status arriving with the retry budget already spent —
 * is only available when the budget is this call's own. In a sequence sharing one
 * policy the ceiling belongs to the longest script, so a retryable terminal would
 * be retried and the script would no longer describe the dispatches.
 */
function terminalStep(rng: Rng, allowExhausted: boolean): Step {
  const kinds = allowExhausted
    ? (['stream', 'permanent', 'exhausted'] as const)
    : (['stream', 'permanent'] as const)
  switch (pick<'stream' | 'permanent' | 'exhausted'>(rng, kinds)) {
    case 'stream': return { kind: 'stream' }
    // A status the decorator will not retry, so the call ends here.
    case 'permanent': return { kind: 'status', status: pick(rng, [400, 401, 403, 404] as const) }
    default: return retryableStep(rng)
  }
}

/** The dispatch state a step must be closed with. */
function expectedDispatchState(step: Step): 'sent' | 'unknown' {
  return step.kind === 'throw' ? 'unknown' : 'sent'
}

/**
 * One logical call: its scripted attempts, and the retry ceiling that lets every
 * one of them run.
 *
 * `maxRetries` is `steps.length - 1` by construction, so the script and the
 * policy cannot disagree about how many dispatches are expected.
 */
interface Script {
  readonly steps: readonly Step[]
  readonly maxRetries: number
}

function scriptOf(rng: Rng, allowExhausted = true): Script {
  const attempts = intBetween(rng, 1, 4)
  const steps: Step[] = []
  for (let index = 0; index < attempts - 1; index += 1) steps.push(retryableStep(rng))
  steps.push(terminalStep(rng, allowExhausted))
  return { steps, maxRetries: attempts - 1 }
}

// ---------------------------------------------------------------------------
// Wire doubles
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = 'ghu_attemptAccountingLongLivedToken'

const AUTH_FILE: CopilotAuthFile = Object.freeze({
  version: 1,
  github: Object.freeze({ token: GITHUB_TOKEN, scope: 'read:user' }),
  clientId: 'Iv1.attempt-accounting',
})

/** Chat-completions model id: no `/responses` prefix, so one endpoint is in play. */
const MODEL_ID = 'gpt-4o'

/** A minimal but complete chat-completions stream: text, terminal finish, usage. */
const CHAT_OK: readonly string[] = [
  JSON.stringify({
    id: 'chatcmpl-attempts',
    object: 'chat.completion.chunk',
    created: 1_718_204_350,
    model: MODEL_ID,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-attempts',
    object: 'chat.completion.chunk',
    created: 1_718_204_350,
    model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }),
  JSON.stringify({
    id: 'chatcmpl-attempts',
    object: 'chat.completion.chunk',
    created: 1_718_204_350,
    model: MODEL_ID,
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  }),
  '[DONE]',
]

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The token exchange reply, with an expiry far enough out to never refresh. */
function exchangeResponse(): Response {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 86_400
  return new Response(
    JSON.stringify({
      token: `tid=attempts;exp=${String(expiresAtSeconds)}:signature`,
      expires_at: expiresAtSeconds,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * The `fetch` double: one queue of scripted steps, and two separate counters.
 *
 * The exchange dispatch is counted apart from the surface dispatches on purpose.
 * A `Provider_Attempt` is a call to the Copilot API surface; the token exchange is
 * a `Copilot_Token_Exchange` and is accounted for by Property 52. Folding them
 * into one number would make this property pass or fail for the wrong reason.
 */
interface SurfaceSpy {
  readonly impl: typeof globalThis.fetch
  /** One entry per dispatch at the Copilot surface, in order. */
  readonly dispatches: Step[]
  /** Token exchanges dispatched, which are not attempts. */
  readonly exchanges: () => number
  /** Queue the steps of the next logical call. */
  readonly script: (steps: readonly Step[]) => void
}

function surfaceSpy(): SurfaceSpy {
  const dispatches: Step[] = []
  const queue: Step[] = []
  let exchanges = 0
  const impl = ((input: unknown): Promise<Response> => {
    const url = String(input)
    if (url.includes('/copilot_internal/v2/token')) {
      exchanges += 1
      return Promise.resolve(exchangeResponse())
    }
    const step = queue.shift()
    if (step === undefined) throw new Error(`unscripted dispatch to ${url}`)
    dispatches.push(step)
    if (step.kind === 'throw') {
      return Promise.reject(new TypeError('injected transport failure'))
    }
    if (step.kind === 'stream') return Promise.resolve(sseResponse(CHAT_OK))
    return Promise.resolve(new Response(
      JSON.stringify({ error: { message: 'scripted failure' } }),
      { status: step.status, headers: { 'content-type': 'application/json' } },
    ))
  }) as typeof globalThis.fetch
  return {
    impl,
    dispatches,
    exchanges: () => exchanges,
    script: (steps) => { queue.push(...steps) },
  }
}

// ---------------------------------------------------------------------------
// Observation double
// ---------------------------------------------------------------------------

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

/** A port that retains every captured event, so records can be COUNTED. */
function recordingPort(): { events: ObservationEvent[]; port: ObservationPort } {
  const events: ObservationEvent[] = []
  const port: ObservationPort = {
    mode: 'operational',
    openSpan: createCoreSpan,
    capture(event) {
      events.push(event)
      return accepted(event)
    },
  }
  return { events, port }
}

/** Attempt-level records only, in capture order. */
function attemptRecords(events: readonly ObservationEvent[]): ObservationEvent[] {
  return events.filter(event => event.name === 'sdk.provider.attempt')
}

// ---------------------------------------------------------------------------
// The raw-invocation lens
// ---------------------------------------------------------------------------

/** Raw counts of what the adapter did to the attempt mechanism. */
interface RawAttemptCounts {
  /** One entry per `startProviderAttempt` the adapter invoked. */
  started: number
  /** How many times `end` was invoked on each handle, in start order. */
  readonly closes: number[]
}

/**
 * A decorator adapter that swaps the context for one whose attempt mechanism is
 * counted, then delegates everything else.
 *
 * It sits BELOW `withRetry`, so it sees each physical attempt separately, and
 * ABOVE the Copilot adapter, so what it counts is what the adapter actually did
 * rather than what core retained.
 */
class CountingAttemptAdapter extends ModelAdapter {
  private readonly inner: ModelAdapter
  private readonly counts: RawAttemptCounts

  constructor(inner: ModelAdapter, counts: RawAttemptCounts) {
    super()
    this.inner = inner
    this.counts = counts
  }

  override providerInfo(provider: string): ProviderInfo {
    return this.inner.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.inner.providerRetryPolicy(provider)
  }

  override listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    return this.inner.listModels(provider, signal)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    return this.inner.resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    const prepared = await this.inner.prepareCall(provider, model, signal, this.wrap(context))
    // The dispatch context arrives LATER than the prepare context — the registry
    // prepares once and dispatches with the model call's own context — so the
    // wrap has to happen on both, or the lens sees nothing.
    return {
      model: prepared.model,
      stream: (options, invocation) => prepared.stream(options, this.wrap(invocation)),
    }
  }

  override stream(
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk> {
    return this.inner.stream(options, this.wrap(context))
  }

  private wrap(context?: ModelInvocationContext): ModelInvocationContext | undefined {
    if (context?.startProviderAttempt === undefined) return context
    const start = context.startProviderAttempt.bind(context)
    const counts = this.counts
    return {
      ...context,
      startProviderAttempt: async (input, signal): Promise<ProviderAttemptHandle> => {
        const handle = await start(input, signal)
        const slot = counts.started
        counts.started += 1
        counts.closes[slot] = 0
        return Object.freeze({
          ...handle,
          end: (endInput: EndProviderAttemptInput) => {
            counts.closes[slot] = (counts.closes[slot] ?? 0) + 1
            return handle.end(endInput)
          },
        })
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime assembly
// ---------------------------------------------------------------------------

const REQUEST: GenerateOptions = Object.freeze({
  provider: 'copilot',
  model: MODEL_ID,
  messages: [createTextMessage('hello')],
})

/**
 * One registry over the Copilot adapter, with retries and a recording port.
 *
 * `models` is supplied so discovery never runs: a catalog fetch is a dispatch
 * that is NOT an attempt, and this property counts dispatches.
 */
function runtimeOf(
  spy: SurfaceSpy,
  maxRetries: number,
  counts: RawAttemptCounts,
): { registry: ModelRegistry; events: ObservationEvent[] } {
  const observed = recordingPort()
  const adapter = copilotAdapter({
    authStore: memoryCopilotCredentialStore(AUTH_FILE),
    models: [{ id: MODEL_ID, contextWindow: 128_000, maxTokens: 4_096 }],
    fetch: spy.impl,
    requestTimeoutMs: 5_000,
  })
  const registry = new ModelRegistry({ observation: observed.port })
  registry.registerAdapter(['copilot'], withRetry(new CountingAttemptAdapter(adapter, counts), {
    policy: {
      mode: 'normal',
      maxRetries,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
    random: () => 0,
  }))
  return { registry, events: observed.events }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// ---------------------------------------------------------------------------
// Property 51
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 51: Số bản ghi attempt bằng số `Provider_Attempt`', () => {
  it('emits one attempt record per HTTP dispatch, closed once, with a dispatchState matching where the failure landed', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const script = scriptOf(rng)
      const spy = surfaceSpy()
      const counts: RawAttemptCounts = { started: 0, closes: [] }
      const runtime = runtimeOf(spy, script.maxRetries, counts)
      spy.script(script.steps)
      const trace = `seed ${String(seed)} steps `
        + script.steps.map(step => step.kind === 'status' ? String(step.status) : step.kind).join(',')

      const handle = runtime.registry.stream(REQUEST)
      await drain(handle)
      const report = await handle.report

      // The independent count: every dispatch the surface actually received.
      const dispatched = spy.dispatches.length
      expect(dispatched, `${trace}: dispatches`).toBe(script.steps.length)
      expect(spy.exchanges(), `${trace}: exchanges are not attempts`).toBe(1)

      const records = attemptRecords(runtime.events)
      const starts = records.filter(event => event.phase === 'start')
      const ends = records.filter(event => event.phase === 'end')
      expect(starts, `${trace}: one start record per dispatch`).toHaveLength(dispatched)
      expect(ends, `${trace}: one end record per dispatch`).toHaveLength(dispatched)
      expect(report.attempts, `${trace}: reported attempts`).toHaveLength(dispatched)

      // Closed exactly once: distinct attempt identities, and — through the lens
      // core's dedup hides — exactly one raw `end` per handle.
      const attemptIds = new Set(ends.map(event => event.correlation.attemptId))
      expect(attemptIds.size, `${trace}: distinct closed attempts`).toBe(dispatched)
      expect(counts.started, `${trace}: raw starts`).toBe(dispatched)
      expect(counts.closes, `${trace}: raw closes`).toEqual(Array.from({ length: dispatched }, () => 1))

      // Numbered 1..n with no gap, across the retry boundary.
      expect(starts.map(event => event.data['attemptNumber']), `${trace}: attempt numbers`)
        .toEqual(Array.from({ length: dispatched }, (_, index) => index + 1))
      for (const record of starts) {
        expect(record.data['provider'], trace).toBe('copilot')
        expect(record.data['model'], trace).toBe(MODEL_ID)
        expect(record.data['method'], trace).toBe('POST')
        // Nothing is known to have been sent when the record OPENS.
        expect(record.data['dispatchState'], trace).toBe('not-sent')
      }

      // The dispatchState of each closed record follows the position of that
      // step's failure: a transport failure has no response, so nothing can be
      // claimed beyond `unknown`.
      const expectedStates = spy.dispatches.map(expectedDispatchState)
      expect(ends.map(event => event.data['dispatchState']), `${trace}: end dispatch states`)
        .toEqual(expectedStates)
      expect(
        report.attempts.map(attempt => attempt.dispatchState),
        `${trace}: reported dispatch states`,
      ).toEqual(expectedStates)

      // A status-bearing step carries its HTTP status; a transport failure cannot.
      for (const [index, step] of spy.dispatches.entries()) {
        const at = `${trace} attempt ${String(index)}`
        const attempt = report.attempts[index]
        expect(attempt?.attemptNumber, at).toBe(index + 1)
        // A response carries its status into the record; a transport failure has
        // no status to carry, which is the same distinction `dispatchState` makes.
        if (step.kind === 'throw') expect(attempt?.httpStatus, at).toBeUndefined()
        else expect(attempt?.httpStatus, at).toBe(step.kind === 'status' ? step.status : 200)
        const terminal = index === dispatched - 1
        expect(attempt?.status, at).toBe(step.kind === 'stream' ? 'success' : 'error')
        // Only the last attempt may have succeeded; a retried one failed.
        if (!terminal) expect(step.kind, at).not.toBe('stream')
      }
    }
  })

  it('keeps the ledger balanced across a sequence of logical calls on one route', async () => {
    // "Một chuỗi lời gọi": the counters must not drift between calls, and each
    // call's attempt numbers must restart at 1 while the credential is exchanged
    // once for the whole sequence.
    for (let seed = 1; seed <= 100; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const calls = intBetween(rng, 2, 4)
      const scripts = Array.from({ length: calls }, () => scriptOf(rng, false))
      const ceiling = Math.max(...scripts.map(script => script.maxRetries))
      const spy = surfaceSpy()
      const counts: RawAttemptCounts = { started: 0, closes: [] }
      const runtime = runtimeOf(spy, ceiling, counts)
      const trace = `seed ${String(seed)} calls ${String(calls)}`

      let dispatchedSoFar = 0
      let recordsSoFar = 0
      for (const [index, script] of scripts.entries()) {
        spy.script(script.steps)
        const handle = runtime.registry.stream(REQUEST)
        await drain(handle)
        const report = await handle.report
        const at = `${trace} call ${String(index)}`

        // This call's slice of each ledger.
        const dispatchedHere = spy.dispatches.length - dispatchedSoFar
        // The ceiling is shared, so a call whose script is shorter than the
        // ceiling still stops at its own terminal step.
        expect(dispatchedHere, `${at}: dispatches`).toBe(script.steps.length)
        const records = attemptRecords(runtime.events).slice(recordsSoFar)
        expect(records.filter(event => event.phase === 'start'), `${at}: starts`)
          .toHaveLength(dispatchedHere)
        expect(records.filter(event => event.phase === 'end'), `${at}: ends`)
          .toHaveLength(dispatchedHere)
        expect(report.attempts, `${at}: reported attempts`).toHaveLength(dispatchedHere)
        expect(report.attempts.map(attempt => attempt.attemptNumber), `${at}: numbering`)
          .toEqual(Array.from({ length: dispatchedHere }, (_, n) => n + 1))
        dispatchedSoFar += dispatchedHere
        recordsSoFar += records.length
      }

      expect(counts.started, `${trace}: raw starts total`).toBe(dispatchedSoFar)
      expect(counts.closes, `${trace}: raw closes total`)
        .toEqual(Array.from({ length: dispatchedSoFar }, () => 1))
      // One credential, one exchange, however many attempts it served.
      expect(spy.exchanges(), `${trace}: exchanges`).toBe(1)
    }
  })

  it('records no attempt at all when the failure happens before dispatch', async () => {
    // An empty credential store fails in `auth.resolve`, which runs before the
    // attempt is admitted: zero dispatches, and therefore zero records. An
    // accounting that opened a record first would show a phantom attempt here.
    const spy = surfaceSpy()
    const observed = recordingPort()
    const adapter = copilotAdapter({
      authStore: memoryCopilotCredentialStore(),
      models: [{ id: MODEL_ID }],
      fetch: spy.impl,
    })
    const registry = new ModelRegistry({ observation: observed.port })
    registry.registerAdapter(['copilot'], adapter)

    const handle = registry.stream(REQUEST)
    const chunks = await drain(handle)
    const report = await handle.report

    expect(chunks.at(-1)?.type).toBe('finish')
    expect(spy.dispatches).toHaveLength(0)
    expect(spy.exchanges()).toBe(0)
    expect(attemptRecords(observed.events)).toHaveLength(0)
    expect(report.attempts).toHaveLength(0)
    expect(report.dispatchState).toBe('not-sent')
  })
})
