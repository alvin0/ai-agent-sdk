/**
 * Property tests for embedding cancellation and runtime close.
 *
 * Feature: embedding-support, Property 29: Close report cân bằng số học cho
 * operation embedding.
 * Feature: embedding-support, Property 30: Abort dừng batch chưa gửi và giải
 * phóng body.
 *
 * **Validates: Requirements 12.2, 12.3, 12.4, 12.5**
 *
 * ## Property 29 is an arithmetic claim about a report, so it is tested through
 * the real runtime
 *
 * `RuntimeCloseReport.operations` is produced by `RuntimeOperations.beginClose()`
 * from the leases that were live at the instant admission locked. Faking either
 * side would make the arithmetic trivially true, so the test builds a real
 * `Agent_Runtime` from a real `Embedding_Provider_Plugin` and closes it while a
 * generated number of `Logical_Call`s hang inside the adapter. Four separate
 * statements are checked, because each one alone leaves a plausible wrong
 * implementation standing:
 *
 * 1. a summary for the embedding operation kind EXISTS, and the report carries
 *    one summary per `RUNTIME_OPERATION_KINDS` entry (Requirement 12.2);
 * 2. `activeAtClose === settled + unsettled` for every kind — the balance is the
 *    property, and it must hold whether the hung calls settle during quiescence
 *    or get sealed at the deadline, so the test never pins the split;
 * 3. `activeAtClose` equals the number of calls that were genuinely in flight,
 *    which is asserted against calls that had ALREADY completed before close: a
 *    counter that never decremented would inflate this and pass everything else;
 * 4. every in-flight call is aborted — both as `aborted === activeAtClose` in the
 *    report and as an actual rejection with a stable abort code on each caller's
 *    promise (Requirement 12.5).
 *
 * The legacy top-level fields are checked too. `activeRunsAtClose`, `abortedRuns`
 * and `unsettledRuns` read `operations[0]`, so appending the embedding kind must
 * leave them describing agent runs only — that is DD-4's whole reason for
 * appending rather than prepending, and an accidental reorder would show up here
 * as embedding calls counted as agent runs.
 *
 * Calls are held with a gate rather than a timer: the adapter parks until the
 * batch signal fires, so "in flight" is a fact the test established rather than a
 * race it hopes to win, and the run costs no wall clock.
 *
 * ## Property 30 is about what does NOT happen after an abort
 *
 * Three claims, one generated scenario:
 *
 * 1. **No physical request is produced after the abort moment.** Counted by the
 *    adapter itself: every dispatch that STARTS while the abort flag is set is
 *    tallied, and that tally must be zero. Counting "requests after the abort"
 *    this way rather than comparing totals is what makes the claim survive a
 *    concurrency above one, where batches already on the wire legitimately
 *    finish (Requirement 12.3).
 * 2. **The call ends with a stable abort code.** Asserted for both abort sources
 *    that can reach a `Logical_Call`: the caller's `signal`, and
 *    `Agent_Runtime.close()` aborting the lease. Both must land in the same small
 *    set of abort codes (Requirement 12.4).
 * 3. **The response body of every attempt is released.** Body teardown belongs to
 *    `Http_Transport`, and the obligation `packages/core` carries is the one this
 *    test can honestly check: the signal it hands the adapter as `batch.signal`
 *    fires while the attempt is in flight, so the transport's `finally` runs. The
 *    adapter here stands in for that transport — it holds a real `ReadableStream`
 *    body and cancels it in a `finally`, exactly as `withTransportSession` does —
 *    and the test asserts every body it opened was cancelled and released, with
 *    none left dangling.
 *
 * A real `RuntimeOperations` drives Property 30 rather than a lease double: the
 * fused signal (caller + runtime root) IS the mechanism under test, and a double
 * would be testing the double.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/lifecycle.spec.ts`. No
 * runner collects that directory — root `vitest.config.ts` includes `tests/**`,
 * and the package configs reach into the ROOT `tests/` tree by relative path. A
 * spec there would silently never run. It sits beside its siblings in
 * `tests/unit/embedding/`, as `order.spec.ts` and `plugin-preflight.spec.ts`
 * document for the same reason.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention in
 * the sibling embedding specs is a seeded mulberry32 generator: a failure
 * reproduces from the printed seed and nothing test-only enters the dependency
 * graph. Each property runs `RUNS` cases, above the spec floor of 100.
 *
 * @module tests/unit/embedding/lifecycle.spec
 */
import { describe, expect, it } from 'vitest'
import {
  createEmbeddingModelHandle,
  type EmbeddingHandleOptions,
} from '../../../packages/core/src/composition/embedding/handle.ts'
import { defineEmbeddingProviderPlugin } from '../../../packages/core/src/composition/embedding/definition.ts'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import {
  RUNTIME_OPERATION_KINDS,
  type RuntimeOperationCloseSummary,
} from '../../../packages/core/src/composition/lifecycle/types.ts'
import { createAgentRuntime } from '../../../packages/core/src/composition/runtime/public.ts'
import type { AgentRuntime, RuntimeCloseReport } from '../../../packages/core/src/composition/runtime/types.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import { normalizeModelFailure } from '../../../packages/core/src/errors/failure.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { FakeEmbeddingAdapter } from '../../fixtures/embedding/fake-adapter.ts'

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

function intBetween(rng: Rng, low: number, high: number): number {
  return low + intBelow(rng, high - low + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

/** Yields `count` microtask turns, so an abort can land between two awaits. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve()
}

/** One macrotask, for the few places a microtask drain is not enough. */
function tick(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

const ROUTE = 'fake-embeddings'
const MODEL = 'text-embedding-fake'
const PURPOSE = 'retrieval-document' as const

/**
 * Codes that mean "someone stopped this", as opposed to "the provider broke".
 *
 * Three entries because three different owners can be the one to notice first: the
 * embedding runtime (`EMBEDDING_ABORTED`), a transport-shaped adapter reporting
 * its own cancellation (`ABORTED`), and `RuntimeOperations` sealing a lease during
 * `close()` (`RUNTIME_OPERATION_ABORTED`). Requirement 12.4 asks for a stable
 * code, not for a single code, so the assertion is membership in this set.
 */
const ABORT_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.ABORTED,
  MODEL_ERROR_CODES.ABORTED,
  'RUNTIME_OPERATION_ABORTED',
])

/** The stable code a rejection carries, however exotic the thrown value. */
function codeOf(error: unknown): string {
  return normalizeModelFailure(error).code
}

// ---------------------------------------------------------------------------
// Property 29: a runtime with hung embedding calls
// ---------------------------------------------------------------------------

/**
 * An adapter that can park a batch until its signal fires.
 *
 * The gate is what makes "N calls were in flight when `close()` ran" a fact
 * rather than a hope. While `open` is true the fixture responds normally, so the
 * same adapter also serves the calls that must have COMPLETED before close and
 * must therefore not appear in `activeAtClose`.
 */
class GatedEmbeddingAdapter extends FakeEmbeddingAdapter {
  /** When false, every batch parks until `batch.signal` aborts. */
  open = true
  /** Batches currently parked at the gate. */
  parked = 0

  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    if (!this.open) {
      this.parked += 1
      try {
        await hangUntilAborted(batch.signal)
      } finally {
        this.parked -= 1
      }
    }
    return super.embedBatch(batch, context)
  }
}

/**
 * A promise that only ever rejects, and only when `signal` aborts.
 *
 * It reports `EMBEDDING_ABORTED` rather than rethrowing `signal.reason` because
 * this stands in for a transport that recognises its own cancellation, which is
 * what `Http_Transport` does before an error ever reaches the runtime.
 */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(new EmbeddingError('gated batch aborted', EMBEDDING_ERROR_CODES.ABORTED))
    }
    if (signal === undefined) return
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

/** A runtime whose single route is served by one gated fake adapter. */
async function gatedRuntime(closeTimeoutMs: number): Promise<{
  readonly adapter: GatedEmbeddingAdapter
  readonly runtime: AgentRuntime
}> {
  const adapter = new GatedEmbeddingAdapter({ dimensions: 4 })
  const plugin = defineEmbeddingProviderPlugin({
    id: ROUTE,
    displayName: 'Gated fake embeddings',
    routes: [ROUTE],
    setup(registrar) {
      registrar.registerEmbeddingAdapter(adapter)
      return undefined
    },
  })
  const runtime = await createAgentRuntime({ providers: [plugin], closeTimeoutMs })
  return { adapter, runtime }
}

/** The summary for one operation kind, or a failure naming the missing kind. */
function summaryFor(
  report: RuntimeCloseReport,
  kind: string,
): RuntimeOperationCloseSummary {
  const found = report.operations.find(entry => entry.kind === kind)
  if (found === undefined) expect.unreachable(`close report carries no summary for "${kind}"`)
  return found
}

describe('Feature: embedding-support, Property 29: Close report cân bằng số học cho operation embedding', () => {
  it('balances activeAtClose against settled + unsettled and aborts every live call', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x2f00_0000 + run
      const rng = rngOf(seed)
      const completedCalls = intBelow(rng, 3)
      const liveCalls = intBetween(rng, 1, 4)
      const itemsPerCall = intBetween(rng, 1, 3)
      const context = { seed, completedCalls, liveCalls, itemsPerCall }

      const { adapter, runtime } = await gatedRuntime(intBetween(rng, 5, 25))
      const handle = runtime.embeddingModel({ provider: ROUTE, model: MODEL, dimensions: 4 })

      // Calls that finish BEFORE close: they must not appear in `activeAtClose`.
      for (let call = 0; call < completedCalls; call += 1) {
        const done = await handle.embedMany({
          values: Array.from({ length: itemsPerCall }, (_, item) => `done-${call}-${item}`),
          purpose: PURPOSE,
        })
        expect({ ...context, count: done.embeddings.length }).toEqual({ ...context, count: itemsPerCall })
      }

      // From here on every batch parks, so the calls below are genuinely live.
      adapter.open = false
      const live = Array.from({ length: liveCalls }, (_, call) => handle.embedMany({
        values: Array.from({ length: itemsPerCall }, (_, item) => `live-${call}-${item}`),
        purpose: PURPOSE,
      }))
      // Observing rejections now keeps the close path from seeing them as unhandled.
      const settled = live.map(call => call.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, code: codeOf(error) }),
      ))
      // Each call plans exactly one batch (itemsPerCall is far under the limits),
      // so the gate holds one batch per live call once every call has reached it.
      while (adapter.parked < liveCalls) await tick()

      const report = await runtime.close()
      const embedding = summaryFor(report, 'embedding-call')

      // The property itself, asserted for every kind rather than only embedding:
      // a report that balances only where the test looked would be an accident.
      for (const summary of report.operations) {
        expect({ ...context, kind: summary.kind, balanced: summary.settled + summary.unsettled })
          .toEqual({ ...context, kind: summary.kind, balanced: summary.activeAtClose })
      }
      expect({ ...context, kinds: report.operations.map(entry => entry.kind) })
        .toEqual({ ...context, kinds: [...RUNTIME_OPERATION_KINDS] })

      // Only the live calls count, and all of them were aborted.
      expect({ ...context, active: embedding.activeAtClose, aborted: embedding.aborted })
        .toEqual({ ...context, active: liveCalls, aborted: liveCalls })

      // DD-4: appending the embedding kind must leave the legacy run counters
      // describing `operations[0]` — agent runs — and nothing else.
      expect({
        ...context,
        runs: report.activeRunsAtClose,
        abortedRuns: report.abortedRuns,
        unsettledRuns: report.unsettledRuns,
        first: report.operations[0]?.kind,
      }).toEqual({ ...context, runs: 0, abortedRuns: 0, unsettledRuns: 0, first: 'agent-run' })

      // Requirement 12.5's caller-visible half: every live call really ended, and
      // ended as a cancellation rather than as a result or an opaque failure.
      const outcomes = await Promise.all(settled)
      for (const outcome of outcomes) {
        expect({ ...context, ...outcome, stable: outcome.ok || ABORT_CODES.has(outcome.code) })
          .toEqual({ ...context, ...outcome, stable: true })
        expect({ ...context, ok: outcome.ok }).toEqual({ ...context, ok: false })
      }

      // A gated call spends no successful attempt, so the only attempts recorded
      // are the ones the completed calls paid for.
      expect({ ...context, attempts: adapter.attempts.length })
        .toEqual({ ...context, attempts: completedCalls })
      expect({ ...context, state: report.state }).toEqual({ ...context, state: 'closed' })
    }
  })

  it('reports a zero-filled embedding summary when no embedding call is live', async () => {
    const { runtime } = await gatedRuntime(50)
    const report = await runtime.close()
    expect(summaryFor(report, 'embedding-call')).toEqual({
      kind: 'embedding-call', activeAtClose: 0, aborted: 0, settled: 0, unsettled: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Property 30: abort stops unsent batches and frees every body
// ---------------------------------------------------------------------------

/** One response body the stand-in transport opened for one attempt. */
interface BodyRecord {
  readonly ordinal: number
  /** The `finally` block ran. */
  released: boolean
  /** The stream's own `cancel()` was invoked, so the body was really let go. */
  cancelled: boolean
}

/**
 * A `FakeEmbeddingAdapter` shaped like `Http_Transport`: it opens a real response
 * body per attempt and cancels it in a `finally`, whatever the outcome.
 *
 * It exists to make two runtime obligations observable. `startedAfterAbort`
 * counts dispatches that BEGAN after the abort flag was raised — the number
 * Requirement 12.3 says must be zero — and `bodies` records whether the teardown
 * driven by `batch.signal` actually ran, which is the core-side half of
 * Requirement 12.4.
 */
class TransportLikeAdapter extends FakeEmbeddingAdapter {
  readonly bodies: BodyRecord[] = []
  /** Dispatches that started while the abort flag was already set. */
  startedAfterAbort = 0
  /** Total `embedBatch()` calls, including the one an abort interrupted. */
  dispatched = 0

  constructor(
    private readonly hooks: {
      readonly abortFired: () => boolean
      /** Called at the top of each attempt; may trigger the abort. */
      readonly onDispatch: (ordinal: number) => Promise<void>
    },
  ) {
    super({ dimensions: 4 })
  }

  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    if (this.hooks.abortFired()) this.startedAfterAbort += 1
    this.dispatched += 1
    const ordinal = this.dispatched

    let cancelled = false
    const record: BodyRecord = { ordinal, released: false, cancelled: false }
    this.bodies.push(record)
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel() { cancelled = true },
    })

    try {
      await this.hooks.onDispatch(ordinal)
      // What the transport does on an aborted request: report its own
      // cancellation with a stable code instead of leaking a raw abort reason.
      if (batch.signal?.aborted === true) {
        throw new ModelError('transport aborted mid-attempt', MODEL_ERROR_CODES.ABORTED)
      }
      return await super.embedBatch(batch, context)
    } finally {
      await body.cancel().catch(() => undefined)
      record.cancelled = cancelled
      record.released = true
    }
  }
}

/** A real `RuntimeOperations`, so the lease signal is the production one. */
function operationsOf(): RuntimeOperations {
  return new RuntimeOperations(new RuntimeResources(createRuntimePlatform(globalThis)))
}

describe('Feature: embedding-support, Property 30: Abort dừng batch chưa gửi và giải phóng body', () => {
  it('produces no request after the abort, ends with a stable abort code, and frees every body', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x3a00_0000 + run
      const rng = rngOf(seed)
      const itemCount = intBetween(rng, 3, 7)
      const concurrency = intBetween(rng, 1, 2)
      // 1-based: which attempt is in flight when the abort lands.
      const abortAt = intBetween(rng, 1, itemCount)
      const source = pick(rng, ['caller', 'close'] as const)
      const context = { seed, itemCount, concurrency, abortAt, source }

      const operations = operationsOf()
      const caller = new AbortController()
      let abortFired = false
      let closing: Promise<unknown> | undefined
      const trigger = (): void => {
        abortFired = true
        if (source === 'caller') caller.abort()
        // `close()` seals the lease and aborts the runtime root, which is the
        // other way a live `Logical_Call` can be cancelled (Requirement 12.5).
        else closing = operations.beginClose({ timeoutMs: 25 })
      }

      const adapter = new TransportLikeAdapter({
        abortFired: () => abortFired,
        onDispatch: async (ordinal) => {
          // The request is "on the wire" before anything cancels it, so the abort
          // lands mid-attempt rather than before dispatch.
          await turns(2)
          if (ordinal === abortAt) trigger()
          await turns(2)
        },
      })

      // `maxItems: 1` makes one batch per input, so `abortAt` selects a batch and
      // the batches after it are the ones that must never be sent.
      const options: EmbeddingHandleOptions = {
        provider: ROUTE, model: MODEL, dimensions: 4, concurrency,
        batchLimits: { maxItems: 1 },
      }
      const handle = createEmbeddingModelHandle({ operations, adapter, options })

      let failure: unknown
      let resolved = false
      try {
        await handle.embedMany({
          values: Array.from({ length: itemCount }, (_, item) => `item-${item}`),
          purpose: PURPOSE,
          signal: caller.signal,
        })
        resolved = true
      } catch (error: unknown) {
        failure = error
      }
      if (closing !== undefined) await closing

      // 1. The call failed, and failed as a cancellation.
      expect({ ...context, resolved }).toEqual({ ...context, resolved: false })
      const code = codeOf(failure)
      expect({ ...context, code, stable: ABORT_CODES.has(code) })
        .toEqual({ ...context, code, stable: true })

      // 2. Nothing was dispatched after the abort moment, and the batches beyond
      //    the in-flight window were never sent at all.
      expect({ ...context, after: adapter.startedAfterAbort })
        .toEqual({ ...context, after: 0 })
      expect({
        ...context,
        withinWindow: adapter.dispatched >= abortAt
          && adapter.dispatched <= abortAt + concurrency - 1,
        dispatched: adapter.dispatched,
      }).toEqual({
        ...context,
        withinWindow: true,
        dispatched: adapter.dispatched,
      })
      if (abortAt < itemCount) {
        expect({ ...context, sentEverything: adapter.dispatched >= itemCount })
          .toEqual({ ...context, sentEverything: false })
      }

      // 3. Every body the transport opened was cancelled and released, including
      //    the one belonging to the attempt the abort interrupted.
      expect({ ...context, bodies: adapter.bodies.length })
        .toEqual({ ...context, bodies: adapter.dispatched })
      for (const body of adapter.bodies) {
        expect({ ...context, ...body }).toEqual({
          ...context, ordinal: body.ordinal, released: true, cancelled: true,
        })
      }
    }
  })

  it('spends zero attempts when the signal is already aborted before the call', async () => {
    const operations = operationsOf()
    const caller = new AbortController()
    caller.abort()
    const adapter = new TransportLikeAdapter({
      abortFired: () => true,
      onDispatch: () => Promise.resolve(),
    })
    const handle = createEmbeddingModelHandle({
      operations, adapter, options: { provider: ROUTE, model: MODEL, dimensions: 4 },
    })

    await expect(handle.embed({ value: 'never sent', purpose: PURPOSE, signal: caller.signal }))
      .rejects.toThrow()
    expect(adapter.dispatched).toBe(0)
    expect(adapter.bodies).toHaveLength(0)
  })
})
