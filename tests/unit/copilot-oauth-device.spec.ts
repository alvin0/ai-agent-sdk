/**
 * Property tests for the Copilot OAuth device flow.
 *
 * Feature: github-copilot-provider — Properties 10, 11, 12, 13, 14 and 16, plus
 * the happy-path example the four generated properties are read against.
 *
 * ## No test waits real time
 *
 * Every wait in this file runs on a VIRTUAL CLOCK: {@link virtualClock} is handed
 * to `runCopilotDeviceLogin` through the `timer` option, so the same object owns
 * both `setTimeout` and `now`. A pending wait fires after a fixed number of
 * microtask hops and JUMPS the clock to its own deadline, which is what lets a
 * fifteen-minute bound be checked in a millisecond. A real `setTimeout` here
 * would make the 15-minute property either a 15-minute test or a test nobody
 * runs, and a real `Date.now()` beside a fake timer would let the bound pass by
 * accident in either direction.
 *
 * The wire side is a `fetch` double, so no test needs a credential or a network.
 * It models one behaviour of the platform deliberately: a `fetch` handed an
 * ALREADY-ABORTED signal dispatches nothing. So an invocation on an aborted
 * signal is not recorded as a request, which is what makes "zero requests after
 * the abort" a statement about the network rather than about a function call.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here, following
 * `tests/unit/chat-completions-serialize.spec.ts` and
 * `tests/unit/copilot-auth-store.spec.ts`.
 */

import { readFileSync } from 'node:fs'
import { AgentSdkError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { describe, expect, it } from 'vitest'
import {
  COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
  COPILOT_DEVICE_CODE_MAX_WAIT_MS,
  COPILOT_ERROR_CODES,
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_SLOW_DOWN_INCREMENT_SECONDS,
  CopilotDeviceLoginError,
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
  requestCopilotDeviceCode,
  runCopilotDeviceLogin,
  type CopilotAuthFile,
  type CopilotAuthStore,
  type CopilotCredentialStore,
  type CopilotDeviceCode,
  type CopilotLoginProgress,
  type CopilotLoginResult,
  type CopilotOAuthOptions,
  type CopilotTimer,
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

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

/** `pick` for lists that legitimately contain `undefined` or `null` as a case. */
function pickLoose<T>(rng: Rng, values: readonly T[]): T {
  if (values.length === 0) throw new Error('empty choice list')
  return values[intBelow(rng, values.length)] as T
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

// ---------------------------------------------------------------------------
// Recorded fixtures
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function fixture(name: string): Json {
  const path = new URL(`../../packages/provider-copilot/fixtures/${name}`, import.meta.url)
  return JSON.parse(readFileSync(path, 'utf8')) as Json
}

/** The four `interval` variants recorded in `device-code.json`, keyed by name. */
const DEVICE_CODE_VARIANTS = fixture('device-code.json') as Record<string, Json>

const DEVICE_CODE_VARIANT_NAMES = [
  'intervalNumber',
  'intervalNumericString',
  'intervalAbsent',
  'intervalUnparseable',
] as const

const PENDING_BODY = fixture('device-pending.json')
const SLOW_DOWN_BODY = fixture('device-slow-down.json')
const DENIED_BODY = fixture('device-denied.json')
const EXPIRED_BODY = fixture('device-expired.json')

function deviceCodeVariant(rng: Rng): Json {
  const variant = DEVICE_CODE_VARIANTS[pick(rng, DEVICE_CODE_VARIANT_NAMES)]
  if (variant === undefined) throw new Error('device-code.json is missing a recorded variant')
  return variant
}

// ---------------------------------------------------------------------------
// The virtual clock
// ---------------------------------------------------------------------------

/** Epoch start for every run, so `obtainedAt` is deterministic too. */
const CLOCK_START = 1_700_000_000_000

/**
 * Microtask hops between scheduling a wait and firing it.
 *
 * More than one, so a test can slip an abort in BETWEEN the two — which is the
 * only way to exercise "aborted while waiting between polls" without racing the
 * implementation's own `await` chain.
 */
const FIRE_HOPS = 5

interface VirtualClock {
  /** The injectable scheduler, for the `timer` option. */
  readonly timer: CopilotTimer
  /** Milliseconds asked for, in the order they were asked for. */
  readonly waits: readonly number[]
  /** Current virtual time. */
  readonly now: () => number
  /** Virtual milliseconds since {@link CLOCK_START}. */
  readonly elapsed: () => number
}

/**
 * A clock that only moves when a scheduled wait fires, and jumps straight to that
 * wait's deadline when it does.
 *
 * Self-driving on purpose: there is no `advance()` for a test to call, so a test
 * cannot accidentally move time on a turn the implementation was not waiting, and
 * `await login` is all the driving a case needs.
 * @param onSchedule - called with each requested wait, after it is scheduled.
 */
function virtualClock(onSchedule?: (ms: number, index: number) => void): VirtualClock {
  let current = CLOCK_START
  const waits: number[] = []
  const timer: CopilotTimer = {
    now: () => current,
    setTimeout: (handler: () => void, ms: number) => {
      const handle = { cancelled: false }
      const deadline = current + ms
      const index = waits.length
      waits.push(ms)
      void (async () => {
        for (let hop = 0; hop < FIRE_HOPS; hop += 1) await Promise.resolve()
        if (handle.cancelled) return
        current = Math.max(current, deadline)
        handler()
      })()
      onSchedule?.(ms, index)
      return handle
    },
    clearTimeout: (handle: unknown) => {
      (handle as { cancelled: boolean }).cancelled = true
    },
  }
  return { timer, waits, now: () => current, elapsed: () => current - CLOCK_START }
}

// ---------------------------------------------------------------------------
// The `fetch` double
// ---------------------------------------------------------------------------

const DEVICE_CODE_PATH = '/login/device/code'
const DEVICE_TOKEN_PATH = '/login/oauth/access_token'

type Leg = 'code' | 'token'

/** One dispatched request, with the virtual instant it left at. */
interface Dispatched {
  readonly leg: Leg
  readonly url: string
  readonly body: Json
  readonly at: number
}

/** What the double answers with for one leg. */
interface Answer {
  readonly status?: number
  readonly payload: Json
  /** Return a promise that never settles, to model a request still in flight. */
  readonly inFlight?: boolean
}

interface DeviceServer {
  readonly fetch: typeof globalThis.fetch
  readonly requests: readonly Dispatched[]
  /** Requests dispatched on the token leg only. */
  readonly polls: () => number
}

/**
 * A `fetch` double for the two device-flow legs.
 *
 * The aborted-signal branch is the modelling decision worth reading: a real
 * `fetch` given an aborted signal rejects without touching the network, so the
 * double records nothing and hands back a promise that never settles. The SDK's
 * own abort race is what resolves the call, and "requests dispatched after the
 * abort" stays a statement about bytes on the wire.
 */
function deviceServer(
  clock: VirtualClock,
  answer: (leg: Leg, index: number) => Answer,
): DeviceServer {
  const requests: Dispatched[] = []
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted === true) return new Promise<Response>(() => undefined)
    const url = String(input)
    const leg: Leg = url.endsWith(DEVICE_CODE_PATH) ? 'code' : 'token'
    // The token leg is the only other path this double answers; a URL that is
    // neither would be a call site nobody wrote.
    if (leg === 'token' && !url.endsWith(DEVICE_TOKEN_PATH)) {
      throw new Error(`unexpected device-flow target ${url}`)
    }
    const index = requests.filter(request => request.leg === leg).length
    requests.push({
      leg,
      url,
      body: JSON.parse(String(init?.body ?? '{}')) as Json,
      at: clock.now(),
    })
    const next = answer(leg, index)
    if (next.inFlight === true) return new Promise<Response>(() => undefined)
    return Promise.resolve(new Response(JSON.stringify(next.payload), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof globalThis.fetch
  return {
    fetch: fetchImpl,
    requests,
    polls: () => requests.filter(request => request.leg === 'token').length,
  }
}

/** An access-token answer, which is what a poll sequence ends with when it wins. */
function accessTokenBody(extra: Json = {}): Json {
  return { access_token: 'ghu_generated_token', token_type: 'bearer', scope: 'read:user', ...extra }
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

const operation = (): { signal: AbortSignal; logger: SdkLogger } =>
  ({ signal: new AbortController().signal, logger: NULL_LOGGER })

type AnyStore = CopilotAuthStore | CopilotCredentialStore

const isVersioned = (store: AnyStore): store is CopilotCredentialStore =>
  'commit' in store

/** Call the right overload for whichever store variant a case generated. */
function login(
  store: AnyStore,
  options: CopilotOAuthOptions,
  progress?: CopilotLoginProgress,
): Promise<CopilotLoginResult> {
  return isVersioned(store)
    ? runCopilotDeviceLogin(store, options, progress)
    : runCopilotDeviceLogin(store, options, progress)
}

async function storedFile(store: AnyStore): Promise<CopilotAuthFile | undefined> {
  return isVersioned(store)
    ? (await store.read(operation()))?.value
    : store.read()
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

async function failureOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(() => undefined, (error: unknown) => error)
}

function deviceErrorOf(value: unknown, trace: string): CopilotDeviceLoginError {
  expect(value, trace).toBeInstanceOf(CopilotDeviceLoginError)
  return value as CopilotDeviceLoginError
}

/** The message every device-flow failure has to name, so a CLI can be re-run. */
const LOGIN_COMMAND = 'npm run provider:copilot:login-device'

// ---------------------------------------------------------------------------
// Happy path (Requirement 4.1)
// ---------------------------------------------------------------------------

describe('Copilot device login, happy path', () => {
  it('requests one code, polls twice while pending, then persists the granted token', async () => {
    const clock = virtualClock()
    const code = DEVICE_CODE_VARIANTS.intervalNumber as Json
    const server = deviceServer(clock, (leg, index) => leg === 'code'
      ? { payload: code }
      : { payload: index < 2 ? PENDING_BODY : accessTokenBody({ login: 'octocat', id: 583_231 }) })
    const store = memoryCopilotCredentialStore()
    const prompts: CopilotDeviceCode[] = []
    const polls: { elapsedMs: number; intervalSeconds: number }[] = []

    const result = await login(
      store,
      { fetch: server.fetch, timer: clock.timer },
      {
        onPrompt: (prompt) => prompts.push(prompt),
        onPoll: (elapsedMs, intervalSeconds) => polls.push({ elapsedMs, intervalSeconds }),
      },
    )

    // One code leg, three token legs: two pending answers and the grant.
    expect(server.requests.map(request => request.leg)).toEqual(['code', 'token', 'token', 'token'])
    expect(server.requests[0]?.body).toEqual({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      scope: 'read:user',
    })
    expect(server.requests[1]?.body).toEqual({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: code.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })

    // The prompt carries what the user has to be shown, once.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.userCode).toBe(code.user_code)
    expect(prompts[0]?.verificationUrl).toBe(code.verification_uri)
    expect(prompts[0]?.intervalSeconds).toBe(5)

    // Two five-second waits, on the virtual clock: the third poll succeeded, so
    // there was no third wait.
    expect(clock.waits).toEqual([5_000, 5_000])
    expect(polls).toEqual([
      { elapsedMs: 0, intervalSeconds: 5 },
      { elapsedMs: 5_000, intervalSeconds: 5 },
      { elapsedMs: 10_000, intervalSeconds: 5 },
    ])

    expect(result).toEqual({
      location: '<memory>',
      login: 'octocat',
      accountId: 583_231,
      scope: 'read:user',
    })
    expect(await storedFile(store)).toEqual({
      version: 1,
      github: { token: 'ghu_generated_token', tokenType: 'bearer', scope: 'read:user' },
      account: { login: 'octocat', id: 583_231 },
      clientId: COPILOT_OAUTH_CLIENT_ID,
      obtainedAt: new Date(CLOCK_START + 10_000).toISOString(),
    })
  })
})

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

/**
 * The `interval` shapes the property enumerates: a number, a numeric string,
 * absent, or unparsable.
 *
 * Fractional numbers are outside this space on purpose — the wire format states
 * `interval` in whole seconds, and the numeric-string branch parses with
 * `parseInt`, so a fraction is not one of the four shapes the property is stated
 * over.
 */
const INTERVAL_SHAPES = [
  'number', 'numeric-string', 'absent', 'unparsable', 'non-positive', 'wrong-type',
] as const

type IntervalShape = (typeof INTERVAL_SHAPES)[number]

interface IntervalCase {
  readonly shape: IntervalShape
  /** The value to place on the wire; `undefined` means the field is absent. */
  readonly value: unknown
  /** The interval the flow must report. */
  readonly expected: number
}

function intervalCase(rng: Rng, shape: IntervalShape): IntervalCase {
  switch (shape) {
    case 'number': {
      const value = 1 + intBelow(rng, 120)
      return { shape, value, expected: value }
    }
    case 'numeric-string': {
      const seconds = 1 + intBelow(rng, 120)
      const value = pick(rng, [`${String(seconds)}`, ` ${String(seconds)} `, `${String(seconds)}s`])
      return { shape, value, expected: seconds }
    }
    case 'absent':
      return { shape, value: undefined, expected: COPILOT_DEFAULT_POLL_INTERVAL_SECONDS }
    case 'unparsable':
      return {
        shape,
        value: pick(rng, ['as soon as possible', '', 'NaN', 'soon']),
        expected: COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
      }
    case 'non-positive':
      return {
        shape,
        value: pick(rng, [0, -1, -30, '0', '-5']),
        expected: COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
      }
    default:
      return {
        shape,
        value: pickLoose(rng, [null, true, {}, [], Number.NaN]),
        expected: COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
      }
  }
}

describe('Feature: github-copilot-provider, Property 10: Device code luôn cho ra ba giá trị dùng được', () => {
  it('yields a user code, a verification URL and a positive integer interval for every interval shape', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const recorded = deviceCodeVariant(rng)
      const generated = intervalCase(rng, pick(rng, INTERVAL_SHAPES))
      const payload: Json = { ...recorded }
      if (generated.value === undefined) delete payload.interval
      else payload.interval = generated.value
      const clock = virtualClock()
      const server = deviceServer(clock, () => ({ payload }))
      const trace = `seed ${String(seed)} interval ${generated.shape}`

      const code = await requestCopilotDeviceCode({ fetch: server.fetch, timer: clock.timer })

      // The three values a caller cannot proceed without.
      expect(code.userCode, trace).toBe(recorded.user_code)
      expect(code.verificationUrl, trace).toBe(recorded.verification_uri)
      expect(code.intervalSeconds, trace).toBe(generated.expected)

      // "Usable" is the whole claim: a non-integer or non-positive interval is a
      // wait nobody can schedule, and an empty code is nothing to show a user.
      expect(Number.isInteger(code.intervalSeconds), `${trace}: integer interval`).toBe(true)
      expect(code.intervalSeconds, `${trace}: positive interval`).toBeGreaterThan(0)
      expect(code.userCode.length, `${trace}: user code`).toBeGreaterThan(0)
      expect(new URL(code.verificationUrl).protocol, `${trace}: scheme`).toBe('https:')
      expect(code.deviceCode, trace).toBe(recorded.device_code)
      expect(Number.isInteger(code.expiresInSeconds), `${trace}: integer expiry`).toBe(true)
      expect(code.expiresInSeconds, `${trace}: positive expiry`).toBeGreaterThan(0)

      // One request, on the device-code leg, and nothing else.
      expect(server.requests.map(request => request.leg), trace).toEqual(['code'])
      expect(clock.elapsed(), `${trace}: no wait for a code request`).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

/**
 * `expires_in` values, spanning both sides of the absolute ceiling.
 *
 * The values above 900 are the ones the property is really about: a server that
 * says a code lives for a day must not hold a terminal for a day.
 */
const EXPIRES_IN_SECONDS = [30, 120, 600, 899, 900, 1_800, 7_200, 86_400] as const

/** Server intervals, kept coarse so a 15-minute run is tens of polls, not hundreds. */
const CEILING_INTERVALS = [10, 15, 30, 60, 120, 240] as const

describe('Feature: github-copilot-provider, Property 11: Polling dừng ở biên trên tuyệt đối 15 phút', () => {
  it('ends at min(15 minutes, expires_in) with the timeout code, however long the server claims', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const expiresIn = pick(rng, EXPIRES_IN_SECONDS)
      const intervalSeconds = pick(rng, CEILING_INTERVALS)
      const payload: Json = {
        ...DEVICE_CODE_VARIANTS.intervalNumber as Json,
        expires_in: expiresIn,
        interval: intervalSeconds,
      }
      const clock = virtualClock()
      // Never approved: the only thing that can end this flow is a bound.
      const server = deviceServer(clock, leg => ({ payload: leg === 'code' ? payload : PENDING_BODY }))
      const store = memoryCopilotCredentialStore()
      const trace = `seed ${String(seed)} expires_in ${String(expiresIn)} interval ${String(intervalSeconds)}`

      const failure = await failureOf(login(store, { fetch: server.fetch, timer: clock.timer }))
      const error = deviceErrorOf(failure, trace)

      expect(error.reason, trace).toBe('timeout')
      expect(error.code, trace).toBe(COPILOT_ERROR_CODES.DEVICE_LOGIN_TIMEOUT)
      expect(error.message, `${trace}: names the command to re-run`).toContain(LOGIN_COMMAND)

      // The ceiling is absolute, and `expires_in` only ever pulls it in.
      const bound = Math.min(COPILOT_DEVICE_CODE_MAX_WAIT_MS, expiresIn * 1_000)
      expect(clock.elapsed(), `${trace}: not past the bound`).toBeLessThanOrEqual(bound)
      expect(clock.elapsed(), `${trace}: exactly at the bound`).toBe(bound)
      expect(clock.elapsed(), `${trace}: never past fifteen minutes`)
        .toBeLessThanOrEqual(COPILOT_DEVICE_CODE_MAX_WAIT_MS)
      if (expiresIn * 1_000 < COPILOT_DEVICE_CODE_MAX_WAIT_MS) {
        expect(clock.elapsed(), `${trace}: a shorter expires_in ends sooner`)
          .toBeLessThan(COPILOT_DEVICE_CODE_MAX_WAIT_MS)
      }

      // It polled rather than giving up, and it wrote nothing.
      expect(server.polls(), `${trace}: polled at least once`).toBeGreaterThan(0)
      expect(await storedFile(store), `${trace}: nothing committed`).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

/** One generated poll answer that keeps the flow going. */
interface PendingStep {
  readonly error: 'authorization_pending' | 'slow_down'
  /** The interval the server sends beside the error, when it sends one. */
  readonly serverInterval: number | undefined
}

/**
 * A short sequence, with small intervals.
 *
 * Bounded so the cumulative wait cannot reach the 15-minute deadline: at most
 * eight steps, each at most 20 + 8 × 5 = 60 seconds, is 480 seconds. That keeps
 * this property about the interval arithmetic instead of about the clamp the
 * deadline applies, which is Property 11's subject.
 */
function pendingSequence(rng: Rng): PendingStep[] {
  const length = 1 + intBelow(rng, 8)
  return Array.from({ length }, () => ({
    error: bool(rng) ? 'slow_down' as const : 'authorization_pending' as const,
    serverInterval: pickLoose(rng, [undefined, 1, 2, 5, 10, 20]),
  }))
}

function pendingPayload(step: PendingStep): Json {
  const base = step.error === 'slow_down' ? SLOW_DOWN_BODY : PENDING_BODY
  const payload: Json = { ...base, error: step.error }
  if (step.serverInterval === undefined) delete payload.interval
  else payload.interval = step.serverInterval
  return payload
}

describe('Feature: github-copilot-provider, Property 12: Khoảng chờ không giảm và tăng sau mỗi `slow_down`', () => {
  it('never shortens a wait, strictly lengthens it after every slow_down, and keeps polling', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const startInterval = 1 + intBelow(rng, 20)
      const steps = pendingSequence(rng)
      const codePayload: Json = {
        ...DEVICE_CODE_VARIANTS.intervalNumber as Json,
        interval: startInterval,
        expires_in: 899,
      }
      const clock = virtualClock()
      const server = deviceServer(clock, (leg, index) => {
        if (leg === 'code') return { payload: codePayload }
        const step = steps[index]
        return { payload: step === undefined ? accessTokenBody() : pendingPayload(step) }
      })
      const store = memoryCopilotCredentialStore()
      const trace = `seed ${String(seed)} start ${String(startInterval)} steps ${String(steps.length)}`

      await expect(login(store, { fetch: server.fetch, timer: clock.timer }), trace)
        .resolves.toMatchObject({ location: '<memory>' })

      // Polling continued through every pending/slow_down answer and then took
      // the grant: one more poll than there were steps.
      expect(server.polls(), `${trace}: kept polling`).toBe(steps.length + 1)
      expect(clock.waits, `${trace}: one wait per continuing answer`).toHaveLength(steps.length)

      // The model: max(current, server) on pending, and max(current, server,
      // current + 5) on slow_down, which is what makes a repeated slow_down with
      // no new interval still increase.
      let current = startInterval
      let previous = startInterval
      for (const [index, step] of steps.entries()) {
        const at = `${trace} step ${String(index)} ${step.error}`
        const server_ = step.serverInterval ?? 0
        const next = step.error === 'slow_down'
          ? Math.max(current, server_, current + COPILOT_SLOW_DOWN_INCREMENT_SECONDS)
          : Math.max(current, server_)
        const wait = clock.waits[index]
        expect(wait, at).toBe(next * 1_000)
        // Non-decreasing, always at least what the server asked for, and strictly
        // increasing after a slow_down even when the server sent no new interval.
        expect(wait, `${at}: never shortens`).toBeGreaterThanOrEqual(previous * 1_000)
        expect(wait, `${at}: honours the server interval`)
          .toBeGreaterThanOrEqual((step.serverInterval ?? 0) * 1_000)
        if (step.error === 'slow_down') {
          expect(wait, `${at}: strictly increases`).toBeGreaterThan(previous * 1_000)
        }
        current = next
        previous = next
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

interface TerminalCase {
  readonly error: 'access_denied' | 'expired_token'
  readonly payload: Json
  readonly reason: 'denied' | 'expired'
  readonly code: string
}

const TERMINAL_CASES: readonly TerminalCase[] = [
  {
    error: 'access_denied',
    payload: DENIED_BODY,
    reason: 'denied',
    code: COPILOT_ERROR_CODES.DEVICE_LOGIN_DENIED,
  },
  {
    error: 'expired_token',
    payload: EXPIRED_BODY,
    reason: 'expired',
    code: COPILOT_ERROR_CODES.DEVICE_LOGIN_EXPIRED,
  },
]

describe('Feature: github-copilot-provider, Property 13: `access_denied` và `expired_token` dừng flow bằng hai code phân biệt', () => {
  it('stops at the refusal wherever it appears, with a code that tells the two apart', async () => {
    // The two codes have to differ, or every assertion below could pass while a
    // user is told the wrong thing.
    expect(COPILOT_ERROR_CODES.DEVICE_LOGIN_DENIED)
      .not.toBe(COPILOT_ERROR_CODES.DEVICE_LOGIN_EXPIRED)

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const terminal = pick(rng, TERMINAL_CASES)
      // Position of the refusal: 0 means the very first poll refuses.
      const position = intBelow(rng, 6)
      const before = Array.from({ length: position }, () => ({
        error: bool(rng) ? 'slow_down' as const : 'authorization_pending' as const,
        serverInterval: pickLoose(rng, [undefined, 5, 10]),
      }))
      const clock = virtualClock()
      const server = deviceServer(clock, (leg, index) => {
        if (leg === 'code') {
          return { payload: { ...DEVICE_CODE_VARIANTS.intervalNumber as Json, expires_in: 899 } }
        }
        const step = before[index]
        // Every poll after the refusal would answer with a grant, so a flow that
        // did not stop would SUCCEED — the strongest way to state "it stopped".
        return { payload: index < position ? pendingPayload(step as PendingStep) : index === position ? terminal.payload : accessTokenBody() }
      })
      const store = memoryCopilotCredentialStore()
      const trace = `seed ${String(seed)} ${terminal.error} at poll ${String(position)}`

      const failure = await failureOf(login(store, { fetch: server.fetch, timer: clock.timer }))
      const error = deviceErrorOf(failure, trace)

      expect(error.reason, trace).toBe(terminal.reason)
      expect(error.code, trace).toBe(terminal.code)
      expect(error.message, `${trace}: names the command to re-run`).toContain(LOGIN_COMMAND)

      // Zero requests after the refusal: the refusing poll is the last one.
      expect(server.polls(), `${trace}: no poll after the refusal`).toBe(position + 1)
      expect(clock.waits, `${trace}: no wait after the refusal`).toHaveLength(position)
      expect(await storedFile(store), `${trace}: nothing committed`).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

/** The three moments the property names. */
const ABORT_POSITIONS = ['before-device-code', 'between-polls', 'poll-in-flight'] as const

type AbortPosition = (typeof ABORT_POSITIONS)[number]

describe('Feature: github-copilot-provider, Property 14: Abort dừng device flow ngay lập tức', () => {
  it('ends with the SDK abort code and dispatches nothing after the abort, at every abort moment', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 4_000)
      const position: AbortPosition = pick(rng, ABORT_POSITIONS)
      // Which poll the abort lands on, for the two positions that need one.
      const target = 1 + intBelow(rng, 3)
      const controller = new AbortController()
      const trace = `seed ${String(seed)} ${position} target ${String(target)}`

      let abortedAt: number | undefined
      const abortNow = (clock: VirtualClock): void => {
        abortedAt ??= clock.now()
        controller.abort()
      }

      // A wait is scheduled once per continuing poll, so the nth scheduled wait is
      // the wait that follows the nth poll. Aborting one microtask into it lands
      // INSIDE the wait, after `sleep` has registered its abort listener.
      const clock: VirtualClock = virtualClock((_ms, index) => {
        if (position !== 'between-polls' || index + 1 !== target) return
        queueMicrotask(() => abortNow(clock))
      })

      const server = deviceServer(clock, (leg, index) => {
        if (leg === 'code') {
          return { payload: { ...DEVICE_CODE_VARIANTS.intervalNumber as Json, expires_in: 899 } }
        }
        if (position === 'poll-in-flight' && index + 1 === target) {
          // Aborted with the request already out: nothing ever answers it, and the
          // caller's signal is what has to end the flow.
          abortNow(clock)
          return { payload: {}, inFlight: true }
        }
        return { payload: PENDING_BODY }
      })

      // The read/write store variant, so the abort reaches the device-code leg
      // rather than the store's own abort check. The compare-and-swap variant
      // refuses a pre-aborted read before any HTTP happens; that shape is pinned
      // by the example below.
      const store = memoryCopilotAuthStore()
      if (position === 'before-device-code') abortNow(clock)

      const failure = await failureOf(login(
        store,
        { fetch: server.fetch, timer: clock.timer, signal: controller.signal },
      ))
      const error = deviceErrorOf(failure, trace)

      expect(error.reason, trace).toBe('aborted')
      // The SDK's own abort code, not a Copilot-specific one.
      expect(error.code, trace).toBe(MODEL_ERROR_CODES.ABORTED)
      expect(controller.signal.aborted, trace).toBe(true)

      const at = abortedAt
      expect(at, `${trace}: the case did abort`).not.toBeUndefined()
      const afterAbort = server.requests.filter(request => request.at > (at ?? 0))
      expect(afterAbort, `${trace}: requests dispatched after the abort`).toEqual([])
      if (position === 'before-device-code') {
        expect(server.requests, `${trace}: nothing dispatched at all`).toEqual([])
      } else {
        expect(server.polls(), `${trace}: stopped at the target poll`).toBe(target)
      }
      expect(await storedFile(store), `${trace}: nothing committed`).toBeUndefined()
    }
  })

  it('refuses a pre-aborted login at the compare-and-swap store, before any request', async () => {
    // Worth pinning separately: with the CAS store the abort surfaces from the
    // store read as the platform `AbortError`, so the flow ends without the
    // Copilot device error — but it still ends, and still dispatches nothing.
    const clock = virtualClock()
    const server = deviceServer(clock, () => ({ payload: accessTokenBody() }))
    const controller = new AbortController()
    controller.abort()
    const store = memoryCopilotCredentialStore()

    const failure = await failureOf(login(
      store,
      { fetch: server.fetch, timer: clock.timer, signal: controller.signal },
    ))
    expect((failure as Error).name).toBe('AbortError')
    expect(server.requests).toEqual([])
    expect(await storedFile(store)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

/** A field the endpoint may disclose, may send unusable, or may omit entirely. */
type Disclosure<T> = { readonly wire: unknown; readonly expected: T | undefined; readonly present: boolean }

function stringDisclosure(rng: Rng, value: string): Disclosure<string> {
  switch (pick(rng, ['disclosed', 'empty', 'absent', 'wrong-type'] as const)) {
    case 'disclosed': return { wire: value, expected: value, present: true }
    // An empty string is not a disclosure: there is nothing to show.
    case 'empty': return { wire: '', expected: undefined, present: true }
    case 'absent': return { wire: undefined, expected: undefined, present: false }
    default: return {
      wire: pickLoose(rng, [null, 42, {}, [], true]),
      expected: undefined,
      present: true,
    }
  }
}

function idDisclosure(rng: Rng): Disclosure<number> {
  switch (pick(rng, ['disclosed', 'absent', 'wrong-type', 'not-finite'] as const)) {
    case 'disclosed': {
      const id = 1 + intBelow(rng, 9_999_999)
      return { wire: id, expected: id, present: true }
    }
    case 'absent': return { wire: undefined, expected: undefined, present: false }
    case 'wrong-type': return {
      wire: pickLoose(rng, ['583231', null, {}, true]),
      expected: undefined,
      present: true,
    }
    default: return {
      wire: pick(rng, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
      expected: undefined,
      present: true,
    }
  }
}

function place(payload: Json, key: string, disclosure: Disclosure<unknown>): void {
  if (disclosure.present) payload[key] = disclosure.wire
}

describe('Feature: github-copilot-provider, Property 16: Kết quả đăng nhập luôn mang vị trí lưu, danh tính chỉ khi được tiết lộ', () => {
  it('always reports the store location, and reports identity only where the endpoint disclosed it', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 5_000)
      const loginField = stringDisclosure(rng, `octocat-${String(seed)}`)
      const nameField = stringDisclosure(rng, `Mona ${String(seed)}`)
      const idField = idDisclosure(rng)
      const scopeField = stringDisclosure(rng, pick(rng, ['read:user', 'read:user,repo']))
      const tokenTypeField = stringDisclosure(rng, 'bearer')
      const token = `ghu_generated_${String(seed)}`

      const grant: Json = { access_token: token }
      place(grant, 'login', loginField)
      place(grant, 'name', nameField)
      place(grant, 'id', idField)
      place(grant, 'scope', scopeField)
      place(grant, 'token_type', tokenTypeField)

      const clock = virtualClock()
      const pendingPolls = intBelow(rng, 3)
      const server = deviceServer(clock, (leg, index) => leg === 'code'
        ? { payload: { ...DEVICE_CODE_VARIANTS.intervalNumber as Json, expires_in: 899 } }
        : { payload: index < pendingPolls ? PENDING_BODY : grant })
      // Both store variants report a location, and both are asserted, because the
      // location comes from the captured store rather than from the response.
      const store: AnyStore = bool(rng) ? memoryCopilotCredentialStore() : memoryCopilotAuthStore()
      const trace = `seed ${String(seed)} ${isVersioned(store) ? 'cas' : 'read-write'} store`

      const result = await login(store, { fetch: server.fetch, timer: clock.timer })

      // The location is unconditional.
      expect(result.location, `${trace}: location`).toBe('<memory>')
      // Every identity field is the disclosed value or `undefined` — never a
      // stand-in, and never a value the response did not carry.
      expect(result.login, `${trace}: login`).toBe(loginField.expected)
      expect(result.accountId, `${trace}: account id`).toBe(idField.expected)
      expect(result.scope, `${trace}: scope`).toBe(scopeField.expected)
      expect(Object.keys(result).sort(), trace)
        .toEqual(['accountId', 'location', 'login', 'scope'])

      const stored = await storedFile(store)
      expect(stored?.version, trace).toBe(1)
      expect(stored?.github.token, trace).toBe(token)
      // An undisclosed field is ABSENT from the persisted file, not present as
      // `undefined`: a key with no value is a value somebody will later read.
      expect('scope' in (stored?.github ?? {}), `${trace}: stored scope key`)
        .toBe(scopeField.expected !== undefined)
      expect('tokenType' in (stored?.github ?? {}), `${trace}: stored token type key`)
        .toBe(tokenTypeField.expected !== undefined)
      expect(stored?.github.scope, `${trace}: stored scope`).toBe(scopeField.expected)
      expect(stored?.github.tokenType, `${trace}: stored token type`).toBe(tokenTypeField.expected)

      const disclosedIdentity = loginField.expected !== undefined
        || nameField.expected !== undefined
        || idField.expected !== undefined
      expect(stored?.account !== undefined, `${trace}: account present`).toBe(disclosedIdentity)
      if (disclosedIdentity) {
        const expectedKeys = [
          ...loginField.expected === undefined ? [] : ['login'],
          ...nameField.expected === undefined ? [] : ['name'],
          ...idField.expected === undefined ? [] : ['id'],
        ].sort()
        expect(Object.keys(stored?.account ?? {}).sort(), `${trace}: account keys`)
          .toEqual(expectedKeys)
        expect(stored?.account?.login, `${trace}: stored login`).toBe(loginField.expected)
        expect(stored?.account?.name, `${trace}: stored name`).toBe(nameField.expected)
        expect(stored?.account?.id, `${trace}: stored id`).toBe(idField.expected)
      }
      // The identity in the result agrees with the identity on disk.
      expect(result.login, `${trace}: result agrees with the file`).toBe(stored?.account?.login)
      expect(result.accountId, `${trace}: result agrees with the file`).toBe(stored?.account?.id)
      expect(result.scope, `${trace}: result agrees with the file`).toBe(stored?.github.scope)
    }
  })
})

// ---------------------------------------------------------------------------
// The failures that are not one of the five reasons above
// ---------------------------------------------------------------------------

describe('Copilot device login, other refusals', () => {
  it('reports an unknown OAuth error as a plain failure, and never as a denial', async () => {
    const clock = virtualClock()
    const server = deviceServer(clock, leg => leg === 'code'
      ? { payload: DEVICE_CODE_VARIANTS.intervalNumber as Json }
      : { payload: { error: 'unsupported_grant_type' }, status: 200 })
    const store = memoryCopilotCredentialStore()

    const failure = await failureOf(login(store, { fetch: server.fetch, timer: clock.timer }))
    const error = deviceErrorOf(failure, 'unknown oauth error')
    expect(error.reason).toBe('failed')
    expect(error.code).toBe(COPILOT_ERROR_CODES.DEVICE_LOGIN_FAILED)
    expect(error).toBeInstanceOf(AgentSdkError)
    expect(server.polls()).toBe(1)
  })
})
