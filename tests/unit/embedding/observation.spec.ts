/**
 * Property tests for embedding observation and privacy.
 *
 * Feature: embedding-support, Property 44: Dữ liệu quan sát phân biệt đủ ba mức.
 * Feature: embedding-support, Property 45: Trace và error không chứa nội dung
 * thô, vector thô hay credential.
 *
 * **Validates: Requirements 16.1, 16.4, 16.5**
 *
 * Both properties are observed through ONE capturing `ObservationPort` installed
 * on a real `Logical_Call`, never by calling `observation.ts` directly. That
 * matters: the claim of Requirement 16.1 is not "the record shapes exist" but
 * "one `embed()` emits exactly one call record, one batch record per
 * `Physical_Batch`, and one attempt record per `Provider_Attempt`, correctly
 * parented". Only `handle.ts` decides when each level opens, so only a real call
 * can be evidence.
 *
 * ## Property 44 — three levels, and the parenting between them
 *
 * The count alone is weak: k batch records with all their attempts hung off the
 * CALL span would satisfy a count check and destroy the one thing the three
 * levels exist for, which is answering "which batch cost those retries?". So the
 * test resolves the span id of each batch record from its `batchIndex`, then
 * asserts the attempt records parented under that span are exactly the attempts
 * that batch provoked — a batch scripted to fail twice must show three attempts
 * under ITS span and none under a sibling's.
 *
 * `k` and `m` are computed independently of the SDK: `k` from the input count
 * and the item limit (which is made the binding limit), `m` from the scripted
 * per-batch failure counts. An implementation that emitted one record per
 * adapter call would agree with a self-derived expectation and disagree here.
 *
 * The `Provider_Attempt` level deserves a note. `beginEmbeddingCallObservation`
 * supplies `startProviderAttempt` but never calls it — a transport does, once
 * per dispatch. `FakeEmbeddingAdapter` performs no attempt accounting, so
 * {@link ObservedAdapter} adds exactly the `startProviderAttempt` /
 * `attempt.end` pair a real HTTP adapter performs, and nothing else.
 *
 * ## Property 45 — three things that must never appear
 *
 * A leak test is only as good as its markers, so each generated run mints three
 * unmistakable ones: a token embedded in every input text, vector values that
 * are large distinctive integers, and a credential the "provider" echoes back
 * inside its failure. Every captured record from three scenarios — a successful
 * call, a call that exhausts its retries, and a call aborted mid-flight — is
 * serialized and searched for all three. The failing and aborted paths are in
 * scope on purpose: an error path is where a response body, and with it a
 * credential or a fragment of the caller's document, historically escapes.
 *
 * The mirror assertion is what keeps this from being satisfiable by emitting
 * nothing: the same union of records must still carry `itemCount`, `byteCount`,
 * `estimatedTokens`, a `spaceId`, a `providerAttempts` total, and a failure code
 * for the paths that failed. Redaction that costs the operator the cost answer
 * would fail Requirement 16.1 while passing 16.4.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/observation.spec.ts`. No
 * runner collects that directory: root `vitest.config.ts` includes `tests/**`,
 * and the package configs reach into the ROOT `tests/` tree by relative path.
 * This file sits beside `tests/unit/embedding/{order,planner,retry}.spec.ts`,
 * which document the same deviation.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention in
 * the sibling embedding specs is a seeded mulberry32 generator: a failure
 * reproduces from the printed seed and nothing test-only enters the dependency
 * graph. `RUNS` is above the spec floor of 100.
 *
 * @module tests/unit/embedding/observation.spec
 */

import { describe, expect, it } from 'vitest'
import {
  createEmbeddingModelHandle,
  type EmbeddingHandleOptions,
  type EmbeddingOperationScheduler,
} from '../../../packages/core/src/composition/embedding/handle.ts'
import { safeEmbeddingFailure } from '../../../packages/core/src/composition/embedding/observation.ts'
import type {
  OperationLease,
  OperationOptions,
} from '../../../packages/core/src/composition/lifecycle/types.ts'
import { resolveRetryPolicy } from '../../../packages/core/src/contract/retry-policy.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import type { ObservationEvent } from '../../../packages/core/src/observation/event.ts'
import {
  createCoreSpan,
  type CaptureReceipt,
  type ObservationPort,
  type ObservationSpan,
  type OpenObservationSpanInput,
} from '../../../packages/core/src/observation/port.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import {
  FakeEmbeddingAdapter,
  type FakeEmbeddingBehaviour,
} from '../../fixtures/embedding/fake-adapter.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Generated cases per property; the spec floor is 100. */
const RUNS = 110

/** mulberry32 — small, fast, reproducible from a 32-bit seed. */
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

// ---------------------------------------------------------------------------
// A capturing observation port
// ---------------------------------------------------------------------------

/** One span the SDK opened, recorded by name so parenting can be checked. */
interface OpenedSpan {
  readonly name: OpenObservationSpanInput['name']
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly ends: string[]
}

/** Everything one run's port collected. */
interface Recorder {
  readonly port: ObservationPort
  readonly events: ObservationEvent[]
  readonly spans: OpenedSpan[]
}

/**
 * A port that records and otherwise behaves exactly like the default.
 *
 * Spans are produced by `createCoreSpan`, the same helper the SDK falls back to,
 * so nothing about correlation or `traceparent` differs from an untraced run —
 * the recorder observes, it does not alter.
 */
function recorderPort(): Recorder {
  const events: ObservationEvent[] = []
  const spans: OpenedSpan[] = []
  const port: ObservationPort = {
    mode: 'operational',
    openSpan(input: OpenObservationSpanInput): ObservationSpan {
      const span = createCoreSpan(input)
      const record: OpenedSpan = {
        name: input.name,
        spanId: span.correlation.spanId,
        parentSpanId: span.correlation.parentSpanId,
        ends: [],
      }
      spans.push(record)
      return Object.freeze<ObservationSpan>({
        correlation: span.correlation,
        traceparent: span.traceparent,
        end(status, endedAt, monotonicMs): void {
          record.ends.push(status)
          span.end(status, endedAt, monotonicMs)
        },
      })
    },
    capture(event: ObservationEvent): CaptureReceipt {
      events.push(event)
      return Object.freeze({
        eventId: event.eventId,
        status: 'accepted',
        durable: false,
        boundary: 'none',
      })
    },
  }
  return { port, events, spans }
}

/** Events of one record level and phase, in emission order. */
function eventsOf(
  recorder: Recorder,
  name: string,
  phase: 'start' | 'end',
): readonly ObservationEvent[] {
  return recorder.events.filter(event => event.name === name && event.phase === phase)
}

/** A numeric field of an event payload, or `undefined` when absent. */
function numberField(event: ObservationEvent, key: string): number | undefined {
  const value = (event.data as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

// ---------------------------------------------------------------------------
// Runtime admission double
// ---------------------------------------------------------------------------

/**
 * The narrowest thing the handle will accept: one lease whose signal fuses the
 * caller's.
 *
 * Standing up a whole `RuntimeOperations` would drag close semantics into tests
 * about trace shape; the handle's dependency is structural precisely so this can
 * be a dozen lines. `tests/unit/embedding/order.spec.ts` uses the same double.
 */
function schedulerOf(): EmbeddingOperationScheduler {
  return {
    async execute<T>(
      _kind: 'embedding-call',
      options: OperationOptions,
      work: (lease: OperationLease) => Promise<T>,
    ): Promise<T> {
      const controller = new AbortController()
      const abort = (): void => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
      const lease: OperationLease = {
        signal: controller.signal,
        whenSealed: new Promise<void>(() => undefined),
        publish: (commit: () => void) => {
          commit()
          return true
        },
        settle: () => undefined,
      }
      try {
        return await work(lease)
      } finally {
        options.signal?.removeEventListener('abort', abort)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// An adapter that performs attempt accounting, like a real transport
// ---------------------------------------------------------------------------

/** Origin reported for every attempt; scheme and host only, never a path. */
const ORIGIN = 'https://embeddings.example'

/** Per-batch scripting for {@link ObservedAdapter}. */
interface AttemptScript {
  /** Failed attempts before the batch succeeds, keyed by the batch's first index. */
  readonly failures: (batchKey: number) => number
  /** The value thrown for one failed attempt. */
  readonly error: (batchKey: number, attempt: number) => unknown
}

/**
 * A {@link FakeEmbeddingAdapter} that opens and closes one `Provider_Attempt`
 * per `embedBatch()` call, exactly as `Http_Transport` does.
 *
 * The fixture deliberately performs no attempt accounting, because accounting
 * belongs to the transport. Adding it here — and nothing else — is what makes
 * the third observation level real rather than simulated, and it keeps the
 * one-attempt-per-call contract of Requirement 4.3 intact: the counter below
 * increments once per call, never once per retry decision.
 *
 * Failures are keyed by the batch's FIRST item index rather than by a global
 * call ordinal, so a retry of one batch reuses that batch's script while its
 * siblings keep theirs.
 */
class ObservedAdapter extends FakeEmbeddingAdapter {
  /** Total `embedBatch()` calls, failures included. This is `m`. */
  calls = 0
  /** Attempts per batch key, so the expected fan-out is checkable. */
  readonly callsPerBatch = new Map<number, number>()

  private readonly script: AttemptScript

  constructor(behaviour: FakeEmbeddingBehaviour, script: AttemptScript) {
    super(behaviour)
    this.script = script
  }

  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const key = batch.items[0]?.index ?? -1
    const attempt = (this.callsPerBatch.get(key) ?? 0) + 1
    this.callsPerBatch.set(key, attempt)
    this.calls += 1

    const handle = await context?.startProviderAttempt?.({
      provider: batch.provider,
      model: batch.model,
      method: 'POST',
      origin: ORIGIN,
    })
    try {
      if (attempt <= this.script.failures(key)) throw this.script.error(key, attempt)
      const result = await super.embedBatch(batch, context)
      handle?.end({
        status: 'success',
        dispatchState: 'sent',
        ...(result.usage === undefined ? {} : { reported: result.usage }),
        ...(result.providerRequestId === undefined
          ? {}
          : { providerRequestId: result.providerRequestId }),
      })
      return result
    } catch (error: unknown) {
      // A transport reduces the failure before it reports it; passing the raw
      // value would be the leak this suite exists to detect.
      handle?.end({
        status: 'error',
        dispatchState: 'sent',
        httpStatus: 503,
        error: safeEmbeddingFailure(error),
      })
      throw error
    }
  }
}

/** Backoff pinned low: a hundred runs must not spend seconds sleeping. */
const FAST_RETRY = resolveRetryPolicy(
  { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } },
  'test.retryPolicy',
)

// ---------------------------------------------------------------------------
// Property 44
// ---------------------------------------------------------------------------

/** One generated `Logical_Call` for the three-level count. */
interface LevelCase {
  readonly values: readonly string[]
  readonly maxItems: number
  readonly concurrency: number
  readonly dimensions: number
  /** Failed attempts per plan batch index, in plan order. */
  readonly failures: readonly number[]
  readonly usage: 'reported' | 'absent'
}

function generateLevelCase(rng: Rng, seed: number): LevelCase {
  const itemCount = 1 + intBelow(rng, 9)
  const maxItems = 1 + intBelow(rng, 4)
  const batchCount = Math.ceil(itemCount / maxItems)
  return {
    values: Array.from({ length: itemCount }, (_value, index) => `s${seed}-item-${index}`),
    maxItems,
    concurrency: 1 + intBelow(rng, 3),
    dimensions: 2 + intBelow(rng, 3),
    // Bounded by two: every failure costs a real backoff sleep, and the retry
    // ceiling of three must stay above the scripted count so the call succeeds.
    failures: Array.from({ length: batchCount }, () => (rng() < 0.35 ? 1 + intBelow(rng, 2) : 0)),
    usage: rng() < 0.5 ? 'reported' : 'absent',
  }
}

describe('Feature: embedding-support, Property 44: Dữ liệu quan sát phân biệt đủ ba mức', () => {
  it(`emits one call, k batch and m attempt records with correct parenting across ${RUNS} runs`, async () => {
    let sawRetry = false
    let sawMultiBatch = false
    let sawSingleBatch = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x2c_0000 + run
      const rng = rngOf(seed)
      const generated = generateLevelCase(rng, seed)
      const context = { seed }

      const recorder = recorderPort()
      const adapter = new ObservedAdapter(
        { dimensions: generated.dimensions, usage: generated.usage },
        {
          failures: key => generated.failures[Math.floor(key / generated.maxItems)] ?? 0,
          error: () => new ModelError('scripted transient failure', MODEL_ERROR_CODES.SERVER),
        },
      )
      const options: EmbeddingHandleOptions = {
        provider: 'fake',
        model: 'embed-observed',
        dimensions: generated.dimensions,
        concurrency: generated.concurrency,
        // Items are made the binding limit, so `k` is arithmetic rather than a
        // number read back out of the implementation under test.
        batchLimits: { maxItems: generated.maxItems },
      }
      await createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter,
        options,
        retryPolicy: FAST_RETRY,
        observation: recorder.port,
      }).embedMany({ values: generated.values, purpose: 'retrieval-document' })

      // Expectations derived from the case, not from the SDK.
      const expectedBatches = generated.failures.length
      const expectedAttempts = generated.failures.reduce((sum, count) => sum + count + 1, 0)

      // --- Level 1: exactly one `Logical_Call` record, opened once and closed once.
      const callStarts = eventsOf(recorder, 'sdk.embedding.call', 'start')
      const callEnds = eventsOf(recorder, 'sdk.embedding.call', 'end')
      expect({ ...context, starts: callStarts.length, ends: callEnds.length })
        .toEqual({ ...context, starts: 1, ends: 1 })
      const callSpanId = callStarts[0]!.correlation.spanId
      expect({ ...context, spanId: callEnds[0]!.correlation.spanId })
        .toEqual({ ...context, spanId: callSpanId })

      // --- Level 2: one record per `Physical_Batch`, each parented by the call.
      const batchStarts = eventsOf(recorder, 'sdk.embedding.batch', 'start')
      const batchEnds = eventsOf(recorder, 'sdk.embedding.batch', 'end')
      expect({ ...context, starts: batchStarts.length, ends: batchEnds.length })
        .toEqual({ ...context, starts: expectedBatches, ends: expectedBatches })

      // `batchIndex` → span id, so attempts can be attributed to the batch that
      // provoked them rather than merely counted.
      const batchSpanOf = new Map<number, string>()
      for (const event of batchStarts) {
        const index = numberField(event, 'batchIndex')
        expect({ ...context, hasIndex: index !== undefined }).toEqual({ ...context, hasIndex: true })
        batchSpanOf.set(index as number, event.correlation.spanId)
        expect({ ...context, batchIndex: index, parent: event.correlation.parentSpanId })
          .toEqual({ ...context, batchIndex: index, parent: callSpanId })
      }
      expect({ ...context, distinctBatches: batchSpanOf.size })
        .toEqual({ ...context, distinctBatches: expectedBatches })

      // --- Level 3: one record per `Provider_Attempt`, parented by its batch.
      const attemptStarts = eventsOf(recorder, 'sdk.provider.attempt', 'start')
      const attemptEnds = eventsOf(recorder, 'sdk.provider.attempt', 'end')
      expect({ ...context, starts: attemptStarts.length, ends: attemptEnds.length })
        .toEqual({ ...context, starts: expectedAttempts, ends: expectedAttempts })
      // The record count IS the adapter call count: a level that counted retry
      // decisions or plan entries instead would diverge here.
      expect({ ...context, adapterCalls: adapter.calls })
        .toEqual({ ...context, adapterCalls: expectedAttempts })

      // Fan-out per batch: a batch scripted to fail twice must show three
      // attempts under ITS span, and its siblings must show their own.
      const attemptsUnder = new Map<string, number>()
      for (const event of attemptStarts) {
        const parent = event.correlation.parentSpanId ?? 'none'
        attemptsUnder.set(parent, (attemptsUnder.get(parent) ?? 0) + 1)
      }
      const expectedFanOut = new Map<string, number>()
      for (const [index, failures] of generated.failures.entries()) {
        expectedFanOut.set(batchSpanOf.get(index) as string, failures + 1)
      }
      expect({ ...context, fanOut: [...attemptsUnder.entries()].sort() })
        .toEqual({ ...context, fanOut: [...expectedFanOut.entries()].sort() })

      // Attempt numbering spans the whole `Logical_Call`, so the numbers line up
      // with the `providerAttempts` total the call record publishes.
      expect({ ...context, attempts: numberField(callEnds[0]!, 'providerAttempts') })
        .toEqual({ ...context, attempts: expectedAttempts })

      // Spans, not only events: every level opened a span of its own name and
      // closed it exactly once.
      const spanCounts = {
        call: recorder.spans.filter(span => span.name === 'sdk.embedding.call').length,
        batch: recorder.spans.filter(span => span.name === 'sdk.embedding.batch').length,
        attempt: recorder.spans.filter(span => span.name === 'sdk.provider.attempt').length,
      }
      expect({ ...context, ...spanCounts }).toEqual({
        ...context,
        call: 1,
        batch: expectedBatches,
        attempt: expectedAttempts,
      })
      const unclosed = recorder.spans.filter(span => span.ends.length !== 1)
      expect({ ...context, unclosed: unclosed.map(span => span.name) })
        .toEqual({ ...context, unclosed: [] })

      if (expectedAttempts > expectedBatches) sawRetry = true
      if (expectedBatches > 1) sawMultiBatch = true
      else sawSingleBatch = true
    }

    // Without a retry, m === k and the third level could be a relabelled second
    // level; without both batch shapes, the parenting check is thin.
    expect({ sawRetry, sawMultiBatch, sawSingleBatch })
      .toEqual({ sawRetry: true, sawMultiBatch: true, sawSingleBatch: true })
  })

  it('emits a call record with zero attempts for a call rejected before dispatch', async () => {
    const recorder = recorderPort()
    const adapter = new ObservedAdapter({ dimensions: 3 }, { failures: () => 0, error: () => undefined })

    await expect(createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-observed', dimensions: 3 },
      observation: recorder.port,
      // An empty input list is rejected by pre-dispatch validation.
    }).embedMany({ values: [], purpose: 'retrieval-query' })).rejects.toThrow()

    const callEnds = eventsOf(recorder, 'sdk.embedding.call', 'end')
    expect(callEnds).toHaveLength(1)
    // The cheapest possible answer to "did this cost anything?" is still emitted.
    expect(numberField(callEnds[0]!, 'providerAttempts')).toBe(0)
    expect(eventsOf(recorder, 'sdk.embedding.batch', 'start')).toHaveLength(0)
    expect(eventsOf(recorder, 'sdk.provider.attempt', 'start')).toHaveLength(0)
    expect(adapter.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Property 45
// ---------------------------------------------------------------------------

/** The three markers one run hunts for. */
interface Markers {
  /** Token embedded in every input text. */
  readonly text: string
  /** Decimal rendering of every vector element the "provider" produced. */
  readonly vectors: readonly string[]
  /** Credential the "provider" echoes back inside its failure. */
  readonly credential: string
}

/**
 * A failure shaped like a real provider fault: prose, an echoed credential, and
 * request headers hanging off the cause.
 *
 * This is the value a transport must reduce before reporting. Passing it into a
 * record unreduced is precisely the leak Requirement 16.5 forbids, so the test
 * makes it as tempting as possible to leak.
 */
function leakyFailure(markers: Markers, text: string): ModelError {
  const error = new ModelError(
    `provider rejected the request: authorization=${markers.credential}; input was "${text}"`,
    MODEL_ERROR_CODES.SERVER,
    {
      cause: {
        headers: { authorization: `Bearer ${markers.credential}`, 'x-api-key': markers.credential },
        body: text,
      },
    },
  )
  return error
}

/** Serialized union of every record a run produced, spans included. */
function serialize(recorders: readonly Recorder[]): string {
  return JSON.stringify(recorders.map(recorder => ({
    events: recorder.events,
    spans: recorder.spans,
  })))
}

describe('Feature: embedding-support, Property 45: Trace và error không chứa nội dung thô, vector thô hay credential', () => {
  it(`keeps text, vectors and credentials out of every record across ${RUNS} runs`, async () => {
    let sawFailureRecord = false
    let sawAbortRecord = false
    let sawSuccessRecord = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x2d_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const width = 2 + intBelow(rng, 3)
      const itemCount = 1 + intBelow(rng, 5)
      const marker = `ZQSECRET${seed.toString(16)}TEXT`
      // Large distinctive integers: `JSON.stringify` renders them exactly, so a
      // substring search for a vector element cannot be defeated by formatting.
      const base = 811_000_000 + (run * 10_000)
      const vectorValues = Array.from({ length: width }, (_value, index) => base + (index * 7) + 1)
      const markers: Markers = {
        text: marker,
        vectors: vectorValues.map(value => String(value)),
        credential: `sk-live-${seed.toString(16)}-DEADBEEF`,
      }
      const values = Array.from(
        { length: itemCount },
        (_value, index) => `${marker}/document-${index}/confidential body`,
      )
      const behaviour: FakeEmbeddingBehaviour = {
        dimensions: width,
        // Every item gets the SAME marked values, so one search covers them all.
        vectorFor: () => vectorValues,
      }
      const options: EmbeddingHandleOptions = {
        provider: 'fake',
        model: 'embed-private',
        dimensions: width,
        batchLimits: { maxItems: 1 + intBelow(rng, 2) },
        concurrency: 1 + intBelow(rng, 2),
      }

      // --- Scenario 1: a call that succeeds. Vectors exist and must not be traced.
      const success = recorderPort()
      const successAdapter = new ObservedAdapter(behaviour, {
        // One retry, so a failure record and a success record coexist in one trace.
        failures: key => (key === 0 ? 1 : 0),
        error: () => leakyFailure(markers, values[0] as string),
      })
      const result = await createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter: successAdapter,
        options,
        retryPolicy: FAST_RETRY,
        observation: success.port,
      }).embedMany({ values, purpose: 'retrieval-document' })
      // Non-vacuity at the source: the values being hunted really were produced.
      expect({ ...context, values: [...(result.embeddings[0] as readonly number[])] })
        .toEqual({ ...context, values: [...vectorValues] })

      // --- Scenario 2: a call that exhausts its retries on a leaky failure.
      const failed = recorderPort()
      const failingAdapter = new ObservedAdapter(behaviour, {
        failures: () => Number.MAX_SAFE_INTEGER,
        error: (_key, attempt) => leakyFailure(markers, values[attempt % values.length] as string),
      })
      await expect(createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter: failingAdapter,
        options,
        retryPolicy: resolveRetryPolicy(
          { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } },
          'test.retryPolicy',
        ),
        observation: failed.port,
      }).embedMany({ values, purpose: 'retrieval-query' })).rejects.toThrow()

      // --- Scenario 3: a call aborted while batches are in flight.
      const aborted = recorderPort()
      const abortController = new AbortController()
      const abortingAdapter = new ObservedAdapter(
        { ...behaviour, delayMs: 20 },
        { failures: () => 0, error: () => undefined },
      )
      const pending = createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter: abortingAdapter,
        options: { ...options, batchLimits: { maxItems: 1 }, concurrency: 1 },
        retryPolicy: FAST_RETRY,
        observation: aborted.port,
      }).embedMany({
        values: [...values, `${marker}/tail`],
        purpose: 'retrieval-document',
        signal: abortController.signal,
      })
      // The abort REASON is itself marked, because a caller-supplied reason is
      // one more value that reaches the SDK and must not be traced. It carries
      // the `ABORTED` code a transport would attach, so the terminal status is
      // `aborted` rather than `error` — the distinction an operator needs.
      setTimeout(() => abortController.abort(new ModelError(
        `caller cancelled while embedding "${values[0] as string}" with ${markers.credential}`,
        MODEL_ERROR_CODES.ABORTED,
      )), 1)
      await expect(pending).rejects.toThrow()

      // --- The property: none of the three markers is anywhere in any record.
      const recorded = serialize([success, failed, aborted])
      const leaked = [
        ...(recorded.includes(markers.text) ? ['input-text'] : []),
        ...(recorded.includes(markers.credential) ? ['credential'] : []),
        ...markers.vectors.filter(value => recorded.includes(value)).map(value => `vector:${value}`),
        // Prose from the provider is dropped rather than truncated, so no
        // fragment of the failure message survives either.
        ...(recorded.includes('provider rejected the request') ? ['provider-prose'] : []),
        ...(recorded.includes('Bearer ') ? ['authorization-header'] : []),
      ]
      expect({ ...context, leaked }).toEqual({ ...context, leaked: [] })

      // --- The mirror: redaction did not cost the operator the cost answer.
      const successEnd = eventsOf(success, 'sdk.embedding.call', 'end')[0] as ObservationEvent
      const successData = successEnd.data as Record<string, unknown>
      expect({
        ...context,
        hasSpace: typeof successData.spaceId === 'string',
        attempts: numberField(successEnd, 'providerAttempts'),
        items: numberField(successEnd, 'itemCount'),
      }).toEqual({
        ...context,
        hasSpace: true,
        attempts: successAdapter.calls,
        items: values.length,
      })
      const batchStart = eventsOf(success, 'sdk.embedding.batch', 'start')[0] as ObservationEvent
      expect({
        ...context,
        bytes: (numberField(batchStart, 'byteCount') ?? 0) > 0,
        tokens: (numberField(batchStart, 'estimatedTokens') ?? 0) > 0,
        items: (numberField(batchStart, 'itemCount') ?? 0) > 0,
      }).toEqual({ ...context, bytes: true, tokens: true, items: true })

      // A failure still reports a stable code, which is what a support ticket
      // needs and what makes "no prose" a redaction rather than a silence.
      const failedEnd = eventsOf(failed, 'sdk.embedding.call', 'end')[0] as ObservationEvent
      const failedError = (failedEnd.data as Record<string, unknown>).error as Record<string, unknown>
      expect({ ...context, code: failedError.code, status: failedEnd.data.status })
        .toEqual({ ...context, code: MODEL_ERROR_CODES.SERVER, status: 'error' })

      const abortedEnd = eventsOf(aborted, 'sdk.embedding.call', 'end')[0] as ObservationEvent
      expect({ ...context, status: abortedEnd.data.status })
        .toEqual({ ...context, status: 'aborted' })

      if (eventsOf(success, 'sdk.provider.attempt', 'end').length > 1) sawSuccessRecord = true
      if (failedError.code !== undefined) sawFailureRecord = true
      if (abortedEnd.data.status === 'aborted') sawAbortRecord = true
    }

    expect({ sawSuccessRecord, sawFailureRecord, sawAbortRecord })
      .toEqual({ sawSuccessRecord: true, sawFailureRecord: true, sawAbortRecord: true })
  })

  it('reduces any failure to a stable code, dropping provider prose and credentials', () => {
    const record = safeEmbeddingFailure(new ModelError(
      'authorization=sk-live-secret failed for input "confidential body"',
      MODEL_ERROR_CODES.RATE_LIMIT,
    ))
    expect(record.code).toBe(MODEL_ERROR_CODES.RATE_LIMIT)
    expect(record.message).not.toContain('sk-live-secret')
    expect(record.message).not.toContain('confidential body')
    // A thrown non-Error is reduced the same way: `String(value)` never reaches
    // the record.
    expect(safeEmbeddingFailure({ secret: 'sk-live-secret' }).message)
      .not.toContain('sk-live-secret')
  })
})
