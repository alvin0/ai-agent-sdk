/**
 * Property tests for embedding retry cost and dispatch honesty.
 *
 * Feature: embedding-support, Property 8: Số Provider_Attempt bằng số lần adapter
 * được gọi và được báo cáo đúng.
 *
 * Feature: embedding-support, Property 9: Batch đã thành công không bao giờ được
 * gửi lại.
 *
 * Feature: embedding-support, Property 10: Timeout được ghi là dispatch không
 * xác định.
 *
 * **Validates: Requirements 4.3, 4.7, 4.8, 16.6**
 *
 * All three properties are about MONEY, which is why each one is instrumented at
 * the adapter boundary rather than read off the ledger's own summary:
 *
 * - Property 8 would be vacuous if `attempts` were compared to
 *   `attemptRecords.length` — both are produced by the same counter. So the
 *   dispatcher records one entry per call and the invocation context records one
 *   entry per `startProviderAttempt`, and the property asserts a three-way
 *   equality between the calls actually made, the ledger's `attempts`, and
 *   `EmbeddingUsageReport.providerAttempts` folded by the real aggregator. The
 *   "exactly one physical request per adapter call" half of the claim is the
 *   second list: one attempt start per call, never two (Requirements 4.3, 16.6).
 * - Property 9 is a claim about calls that must NOT happen, so it can only be
 *   tested from the call log. Every batch of a `Logical_Call` is dispatched
 *   concurrently through ONE ledger with a real macrotask inside the retry sleep,
 *   so retries of the still-failing batches genuinely interleave with batches
 *   that already succeeded. The assertion is that a settled `succeeded` batch has
 *   exactly one successful adapter call, that it is the LAST call that batch ever
 *   received, and that asking the ledger to dispatch it again is refused without
 *   touching the adapter (Requirement 4.7).
 * - Property 10 is asserted as a NEGATIVE: a timed-out attempt is never recorded
 *   `'not-sent'`. `'not-sent'` is the only state that claims the provider cannot
 *   have billed the call, and a timeout is never in a position to claim that
 *   (Requirement 4.8). The three timeout moments of the design property are
 *   modelled the way the HTTP transport reports them — nothing reported yet
 *   (timed out before dispatch could be accounted), `'unknown'` (in flight, no
 *   response headers), and `'sent'` (headers arrived, body read timed out) — and
 *   the first two must land on `'unknown'`, never on a guessed `'sent'`.
 *
 * The timeouts here are injected failures, not real elapsed time: `sleep` is
 * injected, so a 120-case property costs no wall clock.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/retry.spec.ts`. No runner
 * collects that directory — root `vitest.config.ts` includes `tests/**`, and the
 * package configs reach into the ROOT `tests/` tree by relative path. A property
 * spec there would never run in CI, the one failure mode a property test must not
 * have. It sits beside `tests/unit/embedding/{planner,usage}.spec.ts` instead,
 * which document the same deviation.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The established
 * convention (`tests/unit/embedding/planner.spec.ts`) is a seeded mulberry32
 * generator: a failure reproduces from the printed seed and nothing enters the
 * dependency graph for test-only reasons. Each property runs `RUNS` cases, above
 * the spec floor of 100.
 *
 * @module tests/unit/embedding/retry.spec
 */

import { describe, expect, it } from 'vitest'
import {
  createEmbeddingRetryLedger,
  type EmbeddingBatchDispatcher,
  type EmbeddingBatchOutcome,
  type EmbeddingRetryLedger,
} from '../../../packages/core/src/composition/embedding/retry.ts'
import { aggregateEmbeddingUsage } from '../../../packages/core/src/composition/embedding/usage.ts'
import {
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from '../../../packages/core/src/contract/retry-policy.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import type {
  ModelInvocationContext,
  ProviderAttemptHandle,
} from '../../../packages/core/src/observation/report.ts'
import type { AttemptUsageReport, DispatchState } from '../../../packages/core/src/observation/usage.ts'

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
  return values[intBelow(rng, values.length)] as T
}

// ---------------------------------------------------------------------------
// Adapter scripts
// ---------------------------------------------------------------------------

/**
 * What one scripted `Provider_Attempt` does.
 *
 * `reportDispatch` is what the TRANSPORT would report through `attempt.end`;
 * `'none'` models a runtime with no attempt accounting wired, where the ledger
 * has nothing to read and must not invent a state.
 */
type ScriptStep =
  | { readonly kind: 'ok' }
  | {
    readonly kind: 'fail'
    readonly code: string
    /** True when this code is in the policy's retryable set. */
    readonly retryable: boolean
    readonly reportDispatch: DispatchState | 'none'
    /** True to throw an `EmbeddingError` rather than a `ModelError`. */
    readonly embeddingError?: boolean
  }

/** Transient codes the default policy retries. */
const RETRYABLE_CODES: readonly string[] = Object.freeze([
  MODEL_ERROR_CODES.RATE_LIMIT,
  MODEL_ERROR_CODES.SERVER,
  MODEL_ERROR_CODES.TIMEOUT,
  MODEL_ERROR_CODES.TRANSPORT,
])

/** Codes that fail identically on every attempt, so the policy refuses them. */
const FATAL_CODES: readonly string[] = Object.freeze([
  MODEL_ERROR_CODES.AUTH,
  MODEL_ERROR_CODES.INVALID_REQUEST,
  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
])

/** Dispatch states a transport can report for a failed attempt. */
const REPORTED_DISPATCH: readonly (DispatchState | 'none')[] = Object.freeze([
  'none',
  'unknown',
  'sent',
  'not-sent',
])

function failStep(rng: Rng, retryable: boolean): ScriptStep {
  const code = retryable ? pick(rng, RETRYABLE_CODES) : pick(rng, FATAL_CODES)
  return {
    kind: 'fail',
    code,
    retryable,
    reportDispatch: pick(rng, REPORTED_DISPATCH),
    ...(code.startsWith('EMBEDDING_') ? { embeddingError: true } : {}),
  }
}

/**
 * A script whose last step is always terminal.
 *
 * The retryable prefix may be longer than the policy allows, which is the
 * exhaustion case: the ledger gives up mid-script and the remaining steps are
 * never reached. That is exactly what the independent simulation below predicts.
 */
function scriptOf(rng: Rng): readonly ScriptStep[] {
  const transientCount = intBelow(rng, 4)
  const steps: ScriptStep[] = []
  for (let index = 0; index < transientCount; index += 1) steps.push(failStep(rng, true))
  steps.push(rng() < 0.6 ? { kind: 'ok' } : failStep(rng, false))
  return Object.freeze(steps)
}

/** What the ledger must do with one script under one policy, folded independently. */
interface ExpectedBatch {
  /** Adapter calls the ledger is allowed to spend. */
  readonly attempts: number
  readonly phase: 'succeeded' | 'failed'
  /** Dispatch state of the settling attempt for a failure. */
  readonly dispatch?: DispatchState
}

function simulate(script: readonly ScriptStep[], policy: ResolvedRetryPolicy): ExpectedBatch {
  let retries = 0
  for (let index = 0; index < script.length; index += 1) {
    const step = script[index] as ScriptStep
    if (step.kind === 'ok') return { attempts: index + 1, phase: 'succeeded' }
    const maxRetries = policy.mode === 'normal' ? policy.maxRetries : Number.POSITIVE_INFINITY
    if (!step.retryable || retries >= maxRetries) {
      return {
        attempts: index + 1,
        phase: 'failed',
        dispatch: step.reportDispatch === 'none' ? 'unknown' : step.reportDispatch,
      }
    }
    retries += 1
  }
  throw new Error('script exhausted: the generator must end every script with a terminal step')
}

// ---------------------------------------------------------------------------
// Instrumented dispatcher
// ---------------------------------------------------------------------------

/** One adapter call, as observed at the boundary the caller is billed for. */
interface AdapterCall {
  readonly batchIndex: number
  /** Attempt starts opened during this single call; the transport opens one. */
  attemptStarts: number
  /** What this scripted call was going to open: one, or none when unaccounted. */
  readonly expectedStarts: number
}

interface Harness {
  readonly dispatcher: EmbeddingBatchDispatcher
  readonly context: ModelInvocationContext
  /** Every adapter call in order; the ground truth for `Provider_Attempt` count. */
  readonly calls: AdapterCall[]
  /** Outcome of each adapter call, aligned with {@link calls}. */
  readonly callOutcomes: ('success' | 'failure')[]
  readonly retriesScheduled: { count: number }
  readonly delays: number[]
}

/**
 * The ledger ignores what `attempt.end` returns, so a stub keeps the harness
 * from restating the whole observation report for a value nothing reads.
 */
const ATTEMPT_REPORT_STUB = {} as unknown as AttemptUsageReport

function harnessOf(
  scripts: ReadonlyMap<EmbeddingBatchRequest, readonly ScriptStep[]>,
  batchIndexes: ReadonlyMap<EmbeddingBatchRequest, number>,
  options: { readonly onBeforeReturn?: (batchIndex: number) => Promise<void> } = {},
): Harness {
  const calls: AdapterCall[] = []
  const callOutcomes: ('success' | 'failure')[] = []
  const retriesScheduled = { count: 0 }
  const delays: number[] = []
  const perBatchCalls = new Map<number, number>()

  // The adapter sets this immediately before opening its attempt, with no await
  // in between, so a start is always attributed to the call that made it even
  // while other batches are in flight.
  const currentCall = { ordinal: -1 }

  const context: ModelInvocationContext = {
    startProviderAttempt: async (_input, _signal): Promise<ProviderAttemptHandle> => {
      const current = calls[currentCall.ordinal]
      if (current !== undefined) current.attemptStarts += 1
      return {
        attemptId: `attempt-${calls.length}`,
        attemptNumber: calls.length,
        traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
        end: () => ATTEMPT_REPORT_STUB,
      } satisfies ProviderAttemptHandle
    },
    recordProviderRetry: () => {
      retriesScheduled.count += 1
    },
  }

  const dispatcher: EmbeddingBatchDispatcher = {
    async embedBatch(batch, invocation): Promise<EmbeddingBatchResult> {
      const batchIndex = batchIndexes.get(batch)
      if (batchIndex === undefined) throw new Error('unknown batch handed to the dispatcher')
      const attemptOfBatch = (perBatchCalls.get(batchIndex) ?? 0) + 1
      perBatchCalls.set(batchIndex, attemptOfBatch)
      const step = (scripts.get(batch) as readonly ScriptStep[])[attemptOfBatch - 1]
      if (step === undefined) throw new Error(`batch ${batchIndex} was dispatched past its script`)

      // The transport opens exactly one attempt per physical request, before the
      // request leaves. Doing it here is what makes "one request per adapter
      // call" observable rather than assumed.
      const reportDispatch = step.kind === 'ok' ? 'sent' : step.reportDispatch
      calls.push({ batchIndex, attemptStarts: 0, expectedStarts: reportDispatch === 'none' ? 0 : 1 })
      const callOrdinal = calls.length - 1
      currentCall.ordinal = callOrdinal
      const attempt = reportDispatch === 'none'
        ? undefined
        : await invocation?.startProviderAttempt?.({
          provider: batch.provider,
          model: batch.model,
          method: 'POST',
          origin: 'https://embedding.invalid',
        })

      // Let other batches make progress while this one is in flight, so a
      // succeeded batch and a retrying batch really do overlap.
      await options.onBeforeReturn?.(batchIndex)

      if (step.kind === 'ok') {
        attempt?.end({ status: 'success', dispatchState: 'sent' })
        callOutcomes[callOrdinal] = 'success'
        return {
          vectors: batch.items.map(item => ({ index: item.index, values: [item.index, 1, 0] })),
          usage: { inputTokens: batch.items.length, totalTokens: batch.items.length },
          providerRequestId: `req-${batchIndex}-${attemptOfBatch}`,
        }
      }

      attempt?.end({
        status: 'error',
        dispatchState: reportDispatch as DispatchState,
        error: { type: 'ModelError', code: step.code, message: 'scripted failure' },
      })
      callOutcomes[callOrdinal] = 'failure'
      throw step.embeddingError === true
        ? new EmbeddingError('scripted embedding failure', step.code, {
          provider: batch.provider,
          model: batch.model,
          itemIndexes: batch.items.map(item => item.index),
        })
        : new ModelError('scripted provider failure', step.code)
    },
  }

  return { dispatcher, context, calls, callOutcomes, retriesScheduled, delays }
}

function requestOf(
  batchIndex: number,
  itemIndexes: readonly number[],
): EmbeddingBatchRequest {
  return {
    provider: 'scripted',
    model: 'embed-test',
    purpose: 'retrieval-document',
    truncation: 'reject',
    items: itemIndexes.map(index => ({
      index,
      contentParts: [{ type: 'text' as const, text: `item ${index} of batch ${batchIndex}` }],
    })),
  }
}

/** One generated `Logical_Call`: its batches, their scripts, and the policy. */
interface GeneratedCall {
  readonly policy: ResolvedRetryPolicy
  readonly requests: readonly EmbeddingBatchRequest[]
  readonly scripts: ReadonlyMap<EmbeddingBatchRequest, readonly ScriptStep[]>
  readonly batchIndexes: ReadonlyMap<EmbeddingBatchRequest, number>
  readonly expected: readonly ExpectedBatch[]
  readonly inputCount: number
}

function generateCall(rng: Rng): GeneratedCall {
  const policy = resolveRetryPolicy(
    {
      mode: 'normal',
      maxRetries: intBelow(rng, 4),
      backoff: { initialDelayMs: 1, maxDelayMs: 4, jitterRatio: 0.1 },
    },
    'test.retryPolicy',
  )
  const batchCount = 1 + intBelow(rng, 4)
  const requests: EmbeddingBatchRequest[] = []
  const scripts = new Map<EmbeddingBatchRequest, readonly ScriptStep[]>()
  const batchIndexes = new Map<EmbeddingBatchRequest, number>()
  const expected: ExpectedBatch[] = []
  let nextItemIndex = 0
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const itemCount = 1 + intBelow(rng, 3)
    const itemIndexes: number[] = []
    for (let item = 0; item < itemCount; item += 1) {
      itemIndexes.push(nextItemIndex)
      nextItemIndex += 1
    }
    const request = requestOf(batchIndex, itemIndexes)
    const script = scriptOf(rng)
    requests.push(request)
    scripts.set(request, script)
    batchIndexes.set(request, batchIndex)
    expected.push(simulate(script, policy))
  }
  return { policy, requests, scripts, batchIndexes, expected, inputCount: nextItemIndex }
}

/** Sleep replacement: records the delay and yields a real macrotask. */
function sleepInto(delays: number[]): (delayMs: number) => Promise<boolean> {
  return async (delayMs: number) => {
    delays.push(delayMs)
    await new Promise(resolve => setTimeout(resolve, 0))
    return true
  }
}

async function runGeneratedCall(
  generated: GeneratedCall,
  rng: Rng,
): Promise<{
  harness: Harness
  outcomes: readonly EmbeddingBatchOutcome[]
  ledger: EmbeddingRetryLedger
}> {
  const harness = harnessOf(generated.scripts, generated.batchIndexes, {
    onBeforeReturn: async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  })
  const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
    policy: generated.policy,
    random: rng,
    context: harness.context,
    sleep: sleepInto(harness.delays),
  })
  // Every batch of the call runs through ONE ledger concurrently: that is the
  // only arrangement in which "a succeeded batch is never re-sent" can fail.
  const outcomes = await Promise.all(
    generated.requests.map(async (request, batchIndex) => ledger.dispatch(batchIndex, request)),
  )
  return { harness, outcomes, ledger }
}

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 8: Số Provider_Attempt bằng số lần adapter được gọi và được báo cáo đúng', () => {
  it(`holds for ${RUNS} generated failure patterns`, async () => {
    let sawRetry = false
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x08_0000 + run
      const rng = rngOf(seed)
      const generated = generateCall(rng)
      const { harness, outcomes } = await runGeneratedCall(generated, rng)
      const context = { seed }

      // Half 1: the ledger's attempt count is the number of calls the adapter
      // actually received, per batch and in total.
      const expectedTotal = generated.expected.reduce((sum, batch) => sum + batch.attempts, 0)
      expect({ ...context, calls: harness.calls.length })
        .toEqual({ ...context, calls: expectedTotal })
      for (const outcome of outcomes) {
        const observed = harness.calls.filter(call => call.batchIndex === outcome.batchIndex).length
        const expected = generated.expected[outcome.batchIndex] as ExpectedBatch
        expect({ ...context, batch: outcome.batchIndex, attempts: outcome.attempts })
          .toEqual({ ...context, batch: outcome.batchIndex, attempts: expected.attempts })
        expect({ ...context, batch: outcome.batchIndex, calls: observed })
          .toEqual({ ...context, batch: outcome.batchIndex, calls: expected.attempts })
        expect(outcome.attemptRecords).toHaveLength(expected.attempts)
        // Records are ordered and numbered 1..n, so a caller can align them with
        // the retries it was charged for.
        expect(outcome.attemptRecords.map(record => record.attempt))
          .toEqual(outcome.attemptRecords.map((_record, index) => index + 1))
        expect(outcome.state.phase).toBe(expected.phase)
      }

      // Half 2: one adapter call is exactly one physical request. The wrapper the
      // ledger puts around the context must forward each start once and no more,
      // so an adapter that retried internally would show up as a second start.
      for (const [ordinal, call] of harness.calls.entries()) {
        expect({ ...context, ordinal, starts: call.attemptStarts })
          .toEqual({ ...context, ordinal, starts: call.expectedStarts })
      }

      // Half 3: the published report carries the same total, so retry cost is
      // observable rather than absorbed (Requirement 16.6).
      const { report } = aggregateEmbeddingUsage({
        inputCount: generated.inputCount,
        batches: outcomes.map(outcome => ({
          itemIndexes: outcome.itemIndexes,
          attempts: outcome.attempts,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        })),
      })
      expect({ ...context, providerAttempts: report.providerAttempts })
        .toEqual({ ...context, providerAttempts: harness.calls.length })

      // Each retry that was actually taken is one extra attempt and was reported
      // to the observation context exactly once before being slept on.
      const retries = expectedTotal - generated.requests.length
      expect({ ...context, scheduled: harness.retriesScheduled.count })
        .toEqual({ ...context, scheduled: retries })
      expect(harness.delays).toHaveLength(retries)
      if (retries > 0) sawRetry = true
    }
    // Non-vacuity: a generator that never produced a retry would let a ledger
    // that ignores retry cost pass every assertion above.
    expect(sawRetry).toBe(true)
  })

  it('counts a retried batch once per adapter call, not once per batch', async () => {
    const request = requestOf(0, [0, 1])
    const script: readonly ScriptStep[] = [
      { kind: 'fail', code: MODEL_ERROR_CODES.RATE_LIMIT, retryable: true, reportDispatch: 'unknown' },
      { kind: 'fail', code: MODEL_ERROR_CODES.SERVER, retryable: true, reportDispatch: 'sent' },
      { kind: 'ok' },
    ]
    const harness = harnessOf(new Map([[request, script]]), new Map([[request, 0]]))
    const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
      policy: resolveRetryPolicy({ mode: 'normal', maxRetries: 5 }, 'test.retryPolicy'),
      random: () => 0.5,
      context: harness.context,
      sleep: sleepInto(harness.delays),
    })
    const outcome = await ledger.dispatch(0, request)

    expect(outcome.state.phase).toBe('succeeded')
    expect(outcome.attempts).toBe(3)
    expect(harness.calls).toHaveLength(3)
    expect(outcome.attemptRecords.map(record => record.outcome))
      .toEqual(['failure', 'failure', 'success'])
    expect(outcome.attemptRecords.map(record => record.failureCode))
      .toEqual([MODEL_ERROR_CODES.RATE_LIMIT, MODEL_ERROR_CODES.SERVER, undefined])

    const { report } = aggregateEmbeddingUsage({
      inputCount: 2,
      batches: [{ itemIndexes: outcome.itemIndexes, attempts: outcome.attempts, usage: outcome.usage }],
    })
    // Three attempts were paid for even though one logical batch was served.
    expect(report.providerAttempts).toBe(3)
    expect(report.status).toBe('complete')
  })
})

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 9: Batch đã thành công không bao giờ được gửi lại', () => {
  it(`holds for ${RUNS} generated failure patterns`, async () => {
    let sawMixedCall = false
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x09_0000 + run
      const rng = rngOf(seed)
      const generated = generateCall(rng)
      const { harness, outcomes, ledger } = await runGeneratedCall(generated, rng)
      const context = { seed }

      const succeeded = outcomes.filter(outcome => outcome.state.phase === 'succeeded')
      const failed = outcomes.filter(outcome => outcome.state.phase === 'failed')
      if (succeeded.length > 0 && failed.length > 0) sawMixedCall = true

      for (const outcome of succeeded) {
        const ordinals = harness.calls
          .map((call, index) => (call.batchIndex === outcome.batchIndex ? index : -1))
          .filter(index => index >= 0)
        const successOrdinals = ordinals.filter(index => harness.callOutcomes[index] === 'success')

        // Sent successfully exactly once, and that send is the last thing this
        // batch ever received: no retry pass picked it up again.
        expect({ ...context, batch: outcome.batchIndex, successes: successOrdinals.length })
          .toEqual({ ...context, batch: outcome.batchIndex, successes: 1 })
        expect({ ...context, batch: outcome.batchIndex, last: ordinals.at(-1) })
          .toEqual({ ...context, batch: outcome.batchIndex, last: successOrdinals[0] })
        expect(outcome.attemptRecords.filter(record => record.outcome === 'success')).toHaveLength(1)
        expect(outcome.attemptRecords.at(-1)?.outcome).toBe('success')

        // The ledger's own view agrees, and the vectors are the ones held.
        const state = outcome.state
        expect(state.phase).toBe('succeeded')
        if (state.phase === 'succeeded') {
          expect(state.vectors.map(vector => vector.index)).toEqual([...outcome.itemIndexes])
        }
        expect(ledger.stateOf(outcome.batchIndex).phase).toBe('succeeded')
      }

      // A second dispatch of any succeeded batch is refused structurally, and the
      // refusal costs no adapter call: the guarantee is not a convention the
      // caller has to remember.
      const callsBefore = harness.calls.length
      for (const outcome of succeeded) {
        const request = generated.requests[outcome.batchIndex] as EmbeddingBatchRequest
        await expect(ledger.dispatch(outcome.batchIndex, request)).rejects.toMatchObject({
          code: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
        })
      }
      expect({ ...context, calls: harness.calls.length })
        .toEqual({ ...context, calls: callsBefore })

      // Failed batches are not silently marked successful just because siblings
      // were: a failure stays a failure the caller must see.
      for (const outcome of failed) {
        expect(outcome.attemptRecords.some(record => record.outcome === 'success')).toBe(false)
      }
    }
    // Non-vacuity: at least one generated call mixed a settled success with a
    // batch that kept retrying, which is the only situation the claim is about.
    expect(sawMixedCall).toBe(true)
  })

  it('refuses to dispatch a succeeded batch again and never touches the adapter', async () => {
    const first = requestOf(0, [0])
    const second = requestOf(1, [1])
    const scripts = new Map<EmbeddingBatchRequest, readonly ScriptStep[]>([
      [first, [{ kind: 'ok' }]],
      [second, [
        { kind: 'fail', code: MODEL_ERROR_CODES.SERVER, retryable: true, reportDispatch: 'unknown' },
        { kind: 'ok' },
      ]],
    ])
    const harness = harnessOf(scripts, new Map([[first, 0], [second, 1]]))
    const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
      policy: resolveRetryPolicy({ mode: 'normal', maxRetries: 3 }, 'test.retryPolicy'),
      random: () => 0.5,
      context: harness.context,
      sleep: sleepInto(harness.delays),
    })

    const [firstOutcome, secondOutcome] = await Promise.all([
      ledger.dispatch(0, first),
      ledger.dispatch(1, second),
    ])
    expect(firstOutcome.state.phase).toBe('succeeded')
    expect(secondOutcome.state.phase).toBe('succeeded')
    expect(harness.calls.filter(call => call.batchIndex === 0)).toHaveLength(1)
    expect(harness.calls.filter(call => call.batchIndex === 1)).toHaveLength(2)

    const callsBefore = harness.calls.length
    await expect(ledger.dispatch(0, first)).rejects.toMatchObject({
      code: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    })
    expect(harness.calls).toHaveLength(callsBefore)
    expect(ledger.stateOf(0).phase).toBe('succeeded')
    // A batch never dispatched is `pending`, not an invented terminal state.
    expect(ledger.stateOf(7).phase).toBe('pending')
    expect([...ledger.states().keys()].sort()).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

/**
 * The three moments a timeout can strike, as the transport reports them.
 *
 * `'sent'` is not a violation of Requirement 4.8 — it is a STRONGER admission
 * that the provider may have billed the call. The forbidden state is
 * `'not-sent'`, the only one that claims the call cannot have been billed.
 */
const TIMEOUT_MOMENTS: readonly {
  readonly name: string
  readonly reportDispatch: DispatchState | 'none'
  readonly expected: DispatchState
}[] = Object.freeze([
  { name: 'before anything could be accounted', reportDispatch: 'none', expected: 'unknown' },
  { name: 'in flight, no response headers yet', reportDispatch: 'unknown', expected: 'unknown' },
  { name: 'headers arrived, body read timed out', reportDispatch: 'sent', expected: 'sent' },
])

describe('Feature: embedding-support, Property 10: Timeout được ghi là dispatch không xác định', () => {
  it(`holds for ${RUNS} generated timeout patterns`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x0a_0000 + run
      const rng = rngOf(seed)
      const timeoutCount = 1 + intBelow(rng, 4)
      const settleWithSuccess = rng() < 0.5
      // The budget is generated against the script rather than independently, so
      // a run either exhausts its retries on timeouts or recovers on the next
      // attempt — never runs off the end of the script.
      const maxRetries = settleWithSuccess
        ? timeoutCount + intBelow(rng, 2)
        : intBelow(rng, timeoutCount)
      const moments = Array.from({ length: timeoutCount }, () => pick(rng, TIMEOUT_MOMENTS))

      const request = requestOf(0, [0, 1])
      const script: ScriptStep[] = moments.map(moment => ({
        kind: 'fail' as const,
        code: MODEL_ERROR_CODES.TIMEOUT,
        retryable: true,
        reportDispatch: moment.reportDispatch,
      }))
      if (settleWithSuccess) script.push({ kind: 'ok' })

      const harness = harnessOf(new Map([[request, script]]), new Map([[request, 0]]))
      const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
        policy: resolveRetryPolicy(
          { mode: 'normal', maxRetries, backoff: { initialDelayMs: 1, maxDelayMs: 4 } },
          'test.retryPolicy',
        ),
        random: rng,
        context: harness.context,
        sleep: sleepInto(harness.delays),
      })
      const outcome = await ledger.dispatch(0, request)
      const context = { seed, moments: moments.map(moment => moment.name) }

      const timeoutRecords = outcome.attemptRecords
        .filter(record => record.failureCode === MODEL_ERROR_CODES.TIMEOUT)
      expect(timeoutRecords.length).toBeGreaterThan(0)
      for (const [index, record] of timeoutRecords.entries()) {
        // The claim: a timeout is never recorded as "the provider never saw it".
        expect({ ...context, index, dispatch: record.dispatch })
          .not.toEqual({ ...context, index, dispatch: 'not-sent' })
        // An unreported state stays unknown rather than being guessed either way.
        const moment = moments[index]
        if (moment !== undefined) {
          expect({ ...context, index, dispatch: record.dispatch })
            .toEqual({ ...context, index, dispatch: moment.expected })
        }
      }

      if (outcome.state.phase === 'failed') {
        expect({ ...context, dispatch: outcome.state.dispatch })
          .not.toEqual({ ...context, dispatch: 'not-sent' })
        // A timeout stays a retryable KIND of failure even when the budget ran out.
        expect(outcome.state.retryable).toBe(true)
        expect(outcome.state.dispatch).toBe(outcome.attemptRecords.at(-1)?.dispatch)
      }

      // Every timed-out attempt is still billable evidence, so it is counted.
      const { report } = aggregateEmbeddingUsage({
        inputCount: 2,
        batches: [{
          itemIndexes: outcome.itemIndexes,
          attempts: outcome.attempts,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        }],
      })
      expect({ ...context, providerAttempts: report.providerAttempts })
        .toEqual({ ...context, providerAttempts: harness.calls.length })
    }
  })

  it('records unknown for a timeout no transport reported on', async () => {
    const request = requestOf(0, [0])
    const script: readonly ScriptStep[] = [
      { kind: 'fail', code: MODEL_ERROR_CODES.TIMEOUT, retryable: true, reportDispatch: 'none' },
    ]
    const harness = harnessOf(new Map([[request, script]]), new Map([[request, 0]]))
    const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
      policy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test.retryPolicy'),
      random: () => 0.5,
      context: harness.context,
      sleep: sleepInto(harness.delays),
    })
    const outcome = await ledger.dispatch(0, request)

    expect(outcome.attempts).toBe(1)
    expect(outcome.attemptRecords[0]?.dispatch).toBe('unknown')
    expect(outcome.state.phase).toBe('failed')
    if (outcome.state.phase === 'failed') {
      expect(outcome.state.dispatch).toBe('unknown')
      expect(outcome.state.error.code).toBe(MODEL_ERROR_CODES.TIMEOUT)
    }
    // Exhausted, so nothing was scheduled and nothing was slept on.
    expect(harness.delays).toEqual([])
  })

  it('keeps unknown when no invocation context is wired at all', async () => {
    const request = requestOf(0, [0])
    const script: readonly ScriptStep[] = [
      { kind: 'fail', code: MODEL_ERROR_CODES.TIMEOUT, retryable: true, reportDispatch: 'none' },
      { kind: 'fail', code: MODEL_ERROR_CODES.TIMEOUT, retryable: true, reportDispatch: 'none' },
    ]
    const harness = harnessOf(new Map([[request, script]]), new Map([[request, 0]]))
    const delays: number[] = []
    const ledger = createEmbeddingRetryLedger(harness.dispatcher, {
      policy: resolveRetryPolicy(
        { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 2, maxDelayMs: 8, jitterRatio: 0 } },
        'test.retryPolicy',
      ),
      random: () => 0.5,
      sleep: sleepInto(delays),
    })
    const outcome = await ledger.dispatch(0, request)

    expect(outcome.attempts).toBe(2)
    expect(outcome.attemptRecords.map(record => record.dispatch)).toEqual(['unknown', 'unknown'])
    expect(delays).toEqual([2])
  })
})
