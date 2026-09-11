/**
 * Property tests for `Copilot_Token_Cache`.
 *
 * Feature: github-copilot-provider — Properties 17, 18, 19 and 52.
 *
 * The cache is one small object with four jobs, and each property here pins one
 * of them: decide when an exchange is due (17), serve many concurrent callers
 * from exactly one exchange without letting one caller's abort hurt another (18),
 * never retry a credential rejection (19), and make the coalescing OBSERVABLE by
 * recording one credential-operation per exchange DISPATCHED rather than per
 * caller served (52).
 *
 * The clock is INJECTED through `options.now`, so every boundary in Property 17
 * is placed exactly rather than waited for, and no fake timer is installed.
 *
 * Inputs come from a SEEDED mulberry32 generator rather than `Math.random`: the
 * repository carries no property-testing library, and a failure has to reproduce
 * from the printed seed. Same shape as `tests/unit/copilot-exchange.spec.ts` and
 * `tests/unit/copilot-auth-store.spec.ts`.
 *
 * ## Three readings of the design that this file settles
 *
 * - **Property 17's "số request đổi token phát ra phải bằng 0" is measured at the
 *   `fetch` double.** The decision itself is `shouldExchange`, already pure and
 *   already covered by example in `copilot-auth-store.spec.ts`; what this file
 *   adds is that the cache ACTS on that decision — a `false` means the caller
 *   gets the very same frozen token object back and not one byte leaves.
 * - **Property 19's "số `Provider_Attempt` … phải bằng 1" is read at this layer as
 *   "exactly one exchange dispatched per `acquire`".** `Provider_Attempt`
 *   accounting belongs to the adapter's request path (Property 51,
 *   `copilot-attempts.spec.ts`); the cache has no attempt loop at all, and the
 *   property that lives here is that it never adds one — a 401 propagates to
 *   every waiting caller unchanged, and a repeat `acquire` re-asks exactly once.
 * - **Property 18 tolerates a run where EVERY caller aborts.** "Các caller còn
 *   lại phải vẫn nhận được token" is vacuous then, so the run instead proves the
 *   exchange survived: a later `acquire` gets the token the abandoned exchange
 *   produced, with no second dispatch. That is the stronger statement anyway —
 *   the shared exchange belongs to no caller.
 */

import {
  AgentSdkError,
  createCoreSpan,
  createObservationRunScope,
  createSpanId,
  createTraceId,
  MODEL_ERROR_CODES,
  type CaptureReceipt,
  type ModelInvocationContext,
  type ObservationEvent,
  type ObservationPort,
  type ObservationResource,
} from '@alvin0/ai-agent-sdk-core'
import type { CredentialOperationOptions, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_ERROR_CODES,
  COPILOT_LOGIN_COMMAND,
  COPILOT_PROVIDER_ID,
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
  COPILOT_TOKEN_EXCHANGE_PATH,
  CopilotTokenExchangeError,
  createCopilotTokenCache,
  DEFAULT_GITHUB_API_BASE_URL,
  shouldExchange,
  type CopilotApiToken,
  type CopilotAuthFile,
  type CopilotCredentialSnapshot,
  type CopilotTokenCacheOptions,
} from '../../packages/provider-copilot/src/index.ts'

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

function intBetween(rng: Rng, low: number, highInclusive: number): number {
  return low + intBelow(rng, highInclusive - low + 1)
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
// Shared doubles
// ---------------------------------------------------------------------------

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

/** The long-lived credential. Its value must never appear in an error message. */
const GITHUB_TOKEN = 'ghu_propertyTestLongLivedUserToken'

const authFile = (token = GITHUB_TOKEN): CopilotAuthFile =>
  ({ version: 1, github: { token, scope: 'read:user' }, clientId: 'Iv1.property-test' })

/** One read of the credential store, as `acquire` receives it. */
const snapshot = (
  token = GITHUB_TOKEN,
  revision: string | null = '0',
): CopilotCredentialSnapshot =>
  ({ file: authFile(token), revision, label: '<memory>' })

/** A caller's operation options: only the signal matters to the cache. */
const caller = (signal: AbortSignal): CredentialOperationOptions =>
  ({ signal, logger: NULL_LOGGER })

/** A caller that never cancels. */
const openCaller = (): CredentialOperationOptions => caller(new AbortController().signal)

/** Yield a macrotask, so an in-flight exchange actually reaches the `fetch` double. */
const tick = (): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, 0) })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A `fetch` double that counts dispatches and can hold every response open.
 *
 * Holding is what makes coalescing testable: while the first exchange is parked
 * on its gate, later callers arrive and must NOT produce a second dispatch. The
 * count is the observable — "one exchange" is not something a promise identity
 * check can prove, but a dispatch counter can.
 */
interface ExchangeSpy {
  readonly impl: typeof globalThis.fetch
  /** One entry per dispatched exchange, in order. */
  readonly dispatches: { url: string; authorization: string | undefined }[]
  /** Resolve every response held so far. */
  readonly release: () => void
  /** How many responses are currently parked. */
  readonly pending: () => number
}

function exchangeSpy(
  replies: readonly (() => Response)[],
  options: { readonly gated: boolean } = { gated: false },
): ExchangeSpy {
  const dispatches: { url: string; authorization: string | undefined }[] = []
  const gates: (() => void)[] = []
  const impl = ((input: unknown, init?: RequestInit) => {
    const index = dispatches.length
    const headers = new Headers(init?.headers ?? {})
    dispatches.push({ url: String(input), authorization: headers.get('authorization') ?? undefined })
    const reply = replies[Math.min(index, replies.length - 1)]
    if (reply === undefined) throw new Error('no scripted reply')
    if (!options.gated) return Promise.resolve(reply())
    return new Promise<Response>((resolve, reject) => {
      gates.push(() => {
        try {
          resolve(reply())
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }) as typeof globalThis.fetch
  return {
    impl,
    dispatches,
    release: () => { for (const gate of gates.splice(0)) gate() },
    pending: () => gates.length,
  }
}

/** A well-formed success body, so a run that should succeed does. */
function successBody(
  expiresAtSeconds: number,
  refreshInSeconds?: number,
): Record<string, unknown> {
  return {
    token: `tid=seeded${String(expiresAtSeconds)};exp=${String(expiresAtSeconds)}:signature`,
    expires_at: expiresAtSeconds,
    ...refreshInSeconds === undefined ? {} : { refresh_in: refreshInSeconds },
  }
}

/** Build a cache over one `fetch` double and one injected clock. */
function cacheOver(
  spy: ExchangeSpy,
  clock: () => number,
  extra: CopilotTokenCacheOptions = {},
): ReturnType<typeof createCopilotTokenCache> {
  return createCopilotTokenCache({
    fetch: spy.impl,
    requestTimeoutMs: 5_000,
    now: clock,
    ...extra,
  })
}

type Outcome =
  | { readonly ok: true; readonly token: CopilotApiToken }
  | { readonly ok: false; readonly error: unknown }

/** Start an `acquire` and capture whatever it produces, thrown or returned. */
function start(
  acquire: () => Promise<CopilotApiToken>,
): Promise<Outcome> {
  return acquire().then(
    (token): Outcome => ({ ok: true, token }),
    (error: unknown): Outcome => ({ ok: false, error }),
  )
}

function exchangeErrorOf(value: unknown, trace: string): CopilotTokenExchangeError {
  expect(value, trace).toBeInstanceOf(CopilotTokenExchangeError)
  return value as CopilotTokenExchangeError
}

/** Whether a rejection is a caller cancellation rather than an exchange failure. */
function isAbort(value: unknown): boolean {
  if (value instanceof AgentSdkError) return value.code === MODEL_ERROR_CODES.ABORTED
  return value instanceof DOMException && value.name === 'AbortError'
}

// ---------------------------------------------------------------------------
// Observation double
// ---------------------------------------------------------------------------

const RESOURCE: ObservationResource = Object.freeze({
  sdkName: 'ai-agent-sdk',
  sdkVersion: '0.0.0-test',
  runtime: 'node',
})

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

/**
 * A context whose every captured event is retained, so records can be COUNTED.
 *
 * Counting is the whole of Property 52: an assertion that a record exists would
 * pass just as well if one were emitted per caller.
 */
function observedContext(): { events: ObservationEvent[]; context: ModelInvocationContext } {
  const events: ObservationEvent[] = []
  const port: ObservationPort = {
    mode: 'operational',
    openSpan: createCoreSpan,
    capture(event) {
      events.push(event)
      return accepted(event)
    },
  }
  const context: ModelInvocationContext = {
    observation: port,
    resource: RESOURCE,
    correlation: {
      traceId: createTraceId(),
      spanId: createSpanId(),
      parentSpanId: null,
      runId: 'run-copilot-token-cache',
    },
    scope: createObservationRunScope(),
    logger: NULL_LOGGER,
  }
  return { events, context }
}

/** Credential-operation records, in capture order. */
function credentialRecords(events: readonly ObservationEvent[]): ObservationEvent[] {
  return events.filter(event => event.name === 'sdk.credential.operation')
}

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

/**
 * The exchange decision, re-derived from the design rather than imported.
 *
 * `expires_at` is the authority and `refresh_in` may only SHORTEN the moment, so
 * the effective instant is the minimum of the two. Stating it independently is
 * the point: calling `shouldExchange` to compute the expectation would make the
 * test agree with whatever the implementation does.
 * @param expiresAtMs - the token's expiry instant.
 * @param marginMs - the configured margin.
 * @param refreshInSeconds - the endpoint's advisory hint, when it sent one.
 * @returns the instant at or after which an exchange is due.
 */
function refreshMomentMs(
  expiresAtMs: number,
  marginMs: number,
  refreshInSeconds: number | undefined,
): number {
  const advisory = refreshInSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : expiresAtMs - refreshInSeconds * 1_000
  return Math.min(expiresAtMs - marginMs, advisory)
}

/** Offsets around the boundary, so the `<=` in the decision is pinned exactly. */
const BOUNDARY_OFFSETS: readonly number[] = [0, -1, 1, -1_000, 1_000, -600_000, 600_000]

describe('Feature: github-copilot-provider, Property 17: Quyết định đổi token đúng theo biên độ đã cấu hình', () => {
  it('exchanges exactly when the effective refresh moment has arrived, and dispatches nothing when it has not', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const expiresAtSeconds = intBetween(rng, 1_700_000_000, 1_900_000_000)
      const expiresAtMs = expiresAtSeconds * 1_000
      const marginMs = bool(rng)
        ? COPILOT_TOKEN_EXCHANGE_MARGIN_MS
        : intBetween(rng, 1, 900_000)
      const refreshInSeconds = bool(rng) ? intBetween(rng, 1, 1_800) : undefined
      const moment = refreshMomentMs(expiresAtMs, marginMs, refreshInSeconds)
      const now = moment + pick(rng, BOUNDARY_OFFSETS)
      const due = moment <= now
      const trace = `seed ${String(seed)} margin ${String(marginMs)} refresh_in `
        + `${String(refreshInSeconds)} now-moment ${String(now - moment)}`

      // A second body with a far-future expiry, so a due exchange is observably
      // a DIFFERENT token rather than the same one handed back twice.
      const later = expiresAtSeconds + 3_600
      const spy = exchangeSpy([
        () => jsonResponse(successBody(expiresAtSeconds, refreshInSeconds)),
        () => jsonResponse(successBody(later)),
      ])
      const cache = cacheOver(spy, () => now, { marginMs })
      const source = snapshot()

      // "Phải luôn trả true khi chưa có token nào": an empty cache exchanges at
      // every clock reading, boundary or not.
      expect(shouldExchange(undefined, now, marginMs), `${trace}: no token yet`).toBe(true)
      const first = await cache.acquire(source, openCaller())
      expect(spy.dispatches, `${trace}: first acquire`).toHaveLength(1)
      expect(first.expiresAtMs, trace).toBe(expiresAtMs)
      expect(first.refreshInSeconds, trace).toBe(refreshInSeconds)
      expect(spy.dispatches[0]?.url, trace)
        .toBe(`${DEFAULT_GITHUB_API_BASE_URL}${COPILOT_TOKEN_EXCHANGE_PATH}`)

      // The decision, stated independently, then the behaviour that follows it.
      expect(shouldExchange(first, now, marginMs), `${trace}: decision`).toBe(due)

      const second = await cache.acquire(source, openCaller())
      if (due) {
        expect(spy.dispatches, `${trace}: exchange was due`).toHaveLength(2)
        expect(second.expiresAtMs, trace).toBe(later * 1_000)
        expect(second, trace).not.toBe(first)
        continue
      }
      // Not due: zero further requests, and the caller gets the very same frozen
      // object — nothing was re-read, re-parsed or re-derived.
      expect(spy.dispatches, `${trace}: exchange was not due`).toHaveLength(1)
      expect(second, trace).toBe(first)
      const third = await cache.acquire(source, openCaller())
      expect(third, trace).toBe(first)
      expect(spy.dispatches, `${trace}: repeated hits`).toHaveLength(1)
    }
  })

  it('rejects a margin that cannot bound anything, at construction and before any request', () => {
    // `0`, a float and a negative all silently disable the margin, which would
    // turn "exchange 5 minutes early" into "exchange when already expired". The
    // refusal lands when the cache is BUILT, so no caller ever reaches a cache
    // whose decision cannot be trusted.
    for (const marginMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const spy = exchangeSpy([() => jsonResponse(successBody(1_800_000_000))])
      expect(() => cacheOver(spy, () => 0, { marginMs }), `margin ${String(marginMs)}`)
        .toThrow(RangeError)
      expect(spy.dispatches, `margin ${String(marginMs)}`).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 18: Nhiều caller đồng thời cho đúng một exchange, và abort của một caller không hại caller khác', () => {
  it('serves any number of concurrent callers from exactly one exchange, and lets any subset abort without harming the rest', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const callers = intBetween(rng, 2, 7)
      const expiresAtSeconds = 1_800_000_000
      const now = expiresAtSeconds * 1_000 - 3_600_000
      const body = successBody(expiresAtSeconds)
      const spy = exchangeSpy([() => jsonResponse(body)], { gated: true })
      const cache = cacheOver(spy, () => now)
      const source = snapshot()
      const trace = `seed ${String(seed)} callers ${String(callers)}`

      // Callers enter at different moments while the one exchange is in flight:
      // some in the same microtask, some a macrotask later.
      const controllers: AbortController[] = []
      const outcomes: Promise<Outcome>[] = []
      for (let index = 0; index < callers; index += 1) {
        const controller = new AbortController()
        controllers.push(controller)
        outcomes.push(start(() => cache.acquire(source, caller(controller.signal))))
        if (index === 0 || bool(rng)) await tick()
      }
      await tick()
      // One dispatch, already parked on its gate: every later caller coalesced.
      expect(spy.dispatches, `${trace}: dispatches while in flight`).toHaveLength(1)
      expect(spy.pending(), `${trace}: parked responses`).toBe(1)

      // An arbitrary subset walks away mid-wait.
      const aborted = new Set<number>()
      for (let index = 0; index < callers; index += 1) {
        if (rng() < 0.4) aborted.add(index)
      }
      for (const index of aborted) controllers[index]?.abort()
      await tick()
      // The abandoning caller did not cancel the shared exchange.
      expect(spy.pending(), `${trace}: exchange still in flight after aborts`).toBe(1)

      spy.release()
      const settled = await Promise.all(outcomes)

      expect(spy.dispatches, `${trace}: total dispatches`).toHaveLength(1)
      expect(spy.dispatches[0]?.authorization, trace).toBe(`Bearer ${GITHUB_TOKEN}`)

      let shared: CopilotApiToken | undefined
      for (const [index, outcome] of settled.entries()) {
        const at = `${trace} caller ${String(index)}`
        if (aborted.has(index)) {
          expect(outcome.ok, `${at}: aborted caller resolved`).toBe(false)
          if (outcome.ok) continue
          expect(isAbort(outcome.error), `${at}: ${String(outcome.error)}`).toBe(true)
          continue
        }
        expect(outcome.ok, `${at}: ${String(outcome.ok ? '' : outcome.error)}`).toBe(true)
        if (!outcome.ok) continue
        // Same token, and the SAME object: one exchange produced one result.
        shared = shared ?? outcome.token
        expect(outcome.token, `${at}: shared token identity`).toBe(shared)
        expect(outcome.token.expiresAtMs, at).toBe(expiresAtSeconds * 1_000)
      }

      // Even when every caller left, the exchange completed and its result is the
      // one a later caller receives — the shared exchange belongs to no caller.
      const after = await cache.acquire(source, openCaller())
      expect(spy.dispatches, `${trace}: dispatches after the wave`).toHaveLength(1)
      expect(after.token, trace).toBe(body['token'])
      if (shared !== undefined) expect(after, trace).toBe(shared)
    }
  })

  it('refuses a caller whose signal was already aborted, without dispatching', async () => {
    const spy = exchangeSpy([() => jsonResponse(successBody(1_800_000_000))])
    const cache = cacheOver(spy, () => 0)
    const controller = new AbortController()
    controller.abort()
    const outcome = await start(() => cache.acquire(snapshot(), caller(controller.signal)))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(isAbort(outcome.error)).toBe(true)
    expect(spy.dispatches).toHaveLength(0)
  })

  it('does not serve a coalesced caller from a different credential value', async () => {
    // The in-flight slot is keyed on the credential VALUE: a second caller holding
    // a token from a different account must get its own exchange, not this one's
    // result.
    const first = successBody(1_800_000_000)
    const second = successBody(1_800_003_600)
    const spy = exchangeSpy([() => jsonResponse(first), () => jsonResponse(second)], { gated: true })
    const cache = cacheOver(spy, () => 1_700_000_000_000)
    const a = start(() => cache.acquire(snapshot(GITHUB_TOKEN), openCaller()))
    await tick()
    const b = start(() => cache.acquire(snapshot('ghu_someOtherAccount'), openCaller()))
    await tick()
    expect(spy.dispatches).toHaveLength(2)
    spy.release()
    const [resolvedA, resolvedB] = await Promise.all([a, b])
    expect(resolvedA.ok && resolvedA.token.token).toBe(first['token'])
    expect(resolvedB.ok && resolvedB.token.token).toBe(second['token'])
  })
})

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

/** Error bodies a rejecting endpoint plausibly sends, one echoing the credential. */
function rejectionBody(rng: Rng): string {
  switch (pick(rng, ['json', 'echo', 'html', 'empty'] as const)) {
    case 'json': return JSON.stringify({ message: 'Bad credentials' })
    case 'echo': return JSON.stringify({ authorization: `Bearer ${GITHUB_TOKEN}` })
    case 'html': return '<html><body>401</body></html>'
    default: return ''
  }
}

describe('Feature: github-copilot-provider, Property 19: Lỗi xác thực của endpoint không bao giờ được retry', () => {
  it('answers any run of 401s with one dispatch per acquire, a permanent classification, and no retry', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const attempts = intBetween(rng, 1, 4)
      const spy = exchangeSpy([() => new Response(
        ((): string | null => {
          const body = rejectionBody(rng)
          return body.length === 0 ? null : body
        })(),
        { status: 401 },
      )])
      const cache = cacheOver(spy, () => 1_700_000_000_000)
      const source = snapshot()
      const trace = `seed ${String(seed)} attempts ${String(attempts)}`

      for (let index = 0; index < attempts; index += 1) {
        const before = spy.dispatches.length
        const outcome = await start(() => cache.acquire(source, openCaller()))
        const at = `${trace} attempt ${String(index)}`

        expect(outcome.ok, at).toBe(false)
        if (outcome.ok) continue
        const error = exchangeErrorOf(outcome.error, at)
        expect(error.code, at).toBe(COPILOT_ERROR_CODES.CREDENTIAL_REJECTED)
        // Not retryable: the endpoint that refused this credential will refuse it
        // again, and this layer has no way to change that.
        expect(error.kind, at).toBe('permanent')
        expect(error.message, at).toContain(COPILOT_LOGIN_COMMAND)
        expect(error.message, at).not.toContain(GITHUB_TOKEN)
        expect(JSON.stringify(error.cause ?? null), at).not.toContain(GITHUB_TOKEN)
        // Exactly one exchange per `acquire`: the failure was returned as-is, not
        // re-attempted behind the caller's back.
        expect(spy.dispatches.length - before, `${at}: dispatches for this acquire`).toBe(1)
      }
      expect(spy.dispatches, `${trace}: total dispatches`).toHaveLength(attempts)

      // Invalidation is what an API-surface 401 triggers, and it reacts by
      // dispatching NOTHING: the refresh decision is made before the next
      // request, never in response to a 401.
      const beforeInvalidate = spy.dispatches.length
      cache.invalidate()
      await tick()
      expect(spy.dispatches.length, `${trace}: dispatches from invalidate`).toBe(beforeInvalidate)
    }
  })

  it('hands one rejection to every coalesced caller, from one dispatch', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const callers = intBetween(rng, 2, 6)
      const status = pick(rng, [401, 403] as const)
      const spy = exchangeSpy(
        [() => new Response(JSON.stringify({ message: 'refused' }), { status })],
        { gated: true },
      )
      const cache = cacheOver(spy, () => 1_700_000_000_000)
      const source = snapshot()
      const trace = `seed ${String(seed)} callers ${String(callers)} status ${String(status)}`

      const outcomes: Promise<Outcome>[] = []
      for (let index = 0; index < callers; index += 1) {
        outcomes.push(start(() => cache.acquire(source, openCaller())))
        await tick()
      }
      expect(spy.dispatches, `${trace}: dispatches`).toHaveLength(1)
      spy.release()
      const settled = await Promise.all(outcomes)

      expect(spy.dispatches, `${trace}: total dispatches`).toHaveLength(1)
      let shared: unknown
      for (const [index, outcome] of settled.entries()) {
        const at = `${trace} caller ${String(index)}`
        expect(outcome.ok, at).toBe(false)
        if (outcome.ok) continue
        const error = exchangeErrorOf(outcome.error, at)
        expect(error.code, at).toBe(COPILOT_ERROR_CODES.CREDENTIAL_REJECTED)
        expect(error.kind, at).toBe('permanent')
        shared = shared ?? outcome.error
        expect(outcome.error, `${at}: one failure, shared`).toBe(shared)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 52
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 52: Bản ghi quan sát của việc đổi token bằng số exchange thực sự phát ra', () => {
  it('records one credential-operation per exchange dispatched, not per caller served', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 4_000)
      const firstWave = intBetween(rng, 2, 6)
      const secondWave = intBetween(rng, 1, 5)
      const providerId = bool(rng) ? COPILOT_PROVIDER_ID : 'copilot-enterprise'
      const marginMs = intBetween(rng, 1_000, 300_000)
      const trace = `seed ${String(seed)} waves ${String(firstWave)}/${String(secondWave)}`

      const firstExpiry = 1_800_000_000
      const secondExpiry = firstExpiry + 7_200
      const spy = exchangeSpy([
        () => jsonResponse(successBody(firstExpiry)),
        () => jsonResponse(successBody(secondExpiry)),
      ], { gated: true })
      let now = firstExpiry * 1_000 - 3_600_000
      const observed = observedContext()
      const cache = cacheOver(spy, () => now, { marginMs, providerId })
      const source = snapshot()

      // Wave one: every caller needs a token, and one exchange serves them all.
      const first: Promise<Outcome>[] = []
      for (let index = 0; index < firstWave; index += 1) {
        first.push(start(() => cache.acquire(source, openCaller(), observed.context)))
        await tick()
      }
      spy.release()
      const firstSettled = await Promise.all(first)
      expect(firstSettled.every(outcome => outcome.ok), trace).toBe(true)
      expect(spy.dispatches, `${trace}: wave one dispatches`).toHaveLength(1)
      expect(credentialRecords(observed.events).filter(event => event.phase === 'start'), trace)
        .toHaveLength(1)

      // Wave two: the clock moves past the refresh moment, so a SECOND exchange
      // is due — and the record count follows the exchanges, not the callers.
      now = firstExpiry * 1_000 - marginMs
      const second: Promise<Outcome>[] = []
      for (let index = 0; index < secondWave; index += 1) {
        second.push(start(() => cache.acquire(source, openCaller(), observed.context)))
        await tick()
      }
      spy.release()
      const secondSettled = await Promise.all(second)
      expect(secondSettled.every(outcome => outcome.ok), trace).toBe(true)

      const dispatched = spy.dispatches.length
      expect(dispatched, `${trace}: total dispatches`).toBe(2)
      const records = credentialRecords(observed.events)
      const starts = records.filter(event => event.phase === 'start')
      const ends = records.filter(event => event.phase === 'end')
      expect(starts, `${trace}: start records equal exchanges`).toHaveLength(dispatched)
      expect(ends, `${trace}: end records equal exchanges`).toHaveLength(dispatched)
      // The point of the property: callers outnumber exchanges, and the record
      // count sided with the exchanges.
      expect(starts.length, `${trace}: records vs callers`)
        .toBeLessThan(firstWave + secondWave)
      for (const record of records) {
        expect(record.data['provider'], trace).toBe(providerId)
        // `'refresh'` is the closed union's nearest name for "exchange"; widening
        // it would change a public `provider-http` type (DD-7).
        expect(record.data['operation'], trace).toBe('refresh')
      }
      for (const record of ends) {
        expect(record.data['status'], trace).toBe('success')
      }
    }
  })

  it('records exactly one failed operation for one failed exchange, however many callers waited', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const rng = rngOf(seed + 5_000)
      const callers = intBetween(rng, 2, 6)
      const status = pick(rng, [401, 403, 429, 500] as const)
      const spy = exchangeSpy(
        [() => new Response(JSON.stringify({ message: 'no' }), { status })],
        { gated: true },
      )
      const observed = observedContext()
      const cache = cacheOver(spy, () => 1_700_000_000_000)
      const source = snapshot()
      const trace = `seed ${String(seed)} callers ${String(callers)} status ${String(status)}`

      const outcomes: Promise<Outcome>[] = []
      for (let index = 0; index < callers; index += 1) {
        outcomes.push(start(() => cache.acquire(source, openCaller(), observed.context)))
        await tick()
      }
      spy.release()
      const settled = await Promise.all(outcomes)
      expect(settled.every(outcome => !outcome.ok), trace).toBe(true)

      const records = credentialRecords(observed.events)
      expect(records.filter(event => event.phase === 'start'), trace).toHaveLength(1)
      const ends = records.filter(event => event.phase === 'end')
      expect(ends, trace).toHaveLength(1)
      expect(ends[0]?.data['status'], trace).toBe('error')
      expect(JSON.stringify(records), `${trace}: credential in observation`)
        .not.toContain(GITHUB_TOKEN)
    }
  })

  it('records nothing when no exchange is due', async () => {
    const spy = exchangeSpy([() => jsonResponse(successBody(1_800_000_000))])
    const observed = observedContext()
    let now = 1_800_000_000 * 1_000 - 3_600_000
    const cache = cacheOver(spy, () => now)
    const source = snapshot()
    await cache.acquire(source, openCaller(), observed.context)
    expect(credentialRecords(observed.events).filter(event => event.phase === 'start'))
      .toHaveLength(1)
    now += 1_000
    for (let index = 0; index < 5; index += 1) {
      await cache.acquire(source, openCaller(), observed.context)
    }
    expect(spy.dispatches).toHaveLength(1)
    expect(credentialRecords(observed.events).filter(event => event.phase === 'start'))
      .toHaveLength(1)
  })
})
