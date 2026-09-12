/**
 * The embedding half of the provider-author contract.
 *
 * Sixteen checks over twelve scenarios, grouped exactly as the nine contract-test
 * groups of Requirement 17: mapping and validation, batching, cancellation and
 * close, retry cost, cache, compatibility, plugin compatibility, privacy, and
 * usage honesty. Results are `ProviderConformanceCheck`es like any other, so they
 * land in the SAME `checks` array of the SAME `ProviderConformanceReport`
 * (Requirement 17.2).
 *
 * Two properties of this runner are worth stating, because they are what make it
 * usable by two providers whose wire formats have nothing in common:
 *
 * - **It knows no endpoint.** Every provider-specific fact — the plugin, the
 *   model id, the scripted response, the declared batch bounds, the expected
 *   error code — arrives through {@link EmbeddingConformanceFixture}. The runner
 *   contributes the CORPUS and the sentinels, so both providers answer the same
 *   questions about the same inputs.
 * - **It compares against provider output, not against itself.** Index fidelity
 *   is checked by asking the fixture what vectors the provider returned, then
 *   comparing element-wise with what the SDK published. Comparing the SDK's
 *   result with the SDK's result would agree even under a permutation.
 *
 * A check never throws: a failing claim is recorded with a support-safe message
 * and the remaining checks still run, so one report explains everything that is
 * wrong rather than the first thing.
 *
 * @module ai-agent-sdk/testkit/provider/embedding/runner
 */

import { createAgentRuntime, type AgentRuntime, type RuntimeCloseReport } from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  estimateTokens,
  type EmbeddingCacheEntry,
  type EmbeddingCacheStore,
  type EmbeddingModelOptions,
  type EmbeddingPurpose,
  type EmbeddingSpaceId,
} from '@alvin0/ai-agent-sdk-core/embedding'
import { PROVIDER_CONFORMANCE_DEFAULTS } from '../config.ts'
import {
  ConformanceAssertionError,
  ConformanceTimeoutError,
  ProviderConformanceError,
  assembleReport,
  assert,
  createCheckCollector,
  required,
  resolveTimeouts,
  within,
  type ResolvedConformanceTimeouts,
} from '../report.ts'
import type {
  ProviderConformanceCheck,
  ProviderConformanceOptions,
  ProviderConformanceReport,
} from '../types.ts'
import { EMBEDDING_CONFORMANCE_DEFAULTS, embeddingConformanceInputs } from './config.ts'
import type {
  EmbeddingConformanceCase,
  EmbeddingConformanceControlSnapshot,
  EmbeddingConformanceDispatch,
  EmbeddingConformanceFixture,
  EmbeddingConformanceScenario,
} from './types.ts'

const ENCODER = new TextEncoder()

/** Codes that mean "the response broke the mapping contract". */
const MAPPING_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
])

/** Codes that mean "a vector itself was unusable". */
const VECTOR_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
])

/**
 * Codes that mean "someone stopped this".
 *
 * A set rather than one value because three owners can be the first to notice a
 * cancellation: the embedding runtime, a transport reporting its own abort, and
 * `RuntimeOperations` sealing a lease during `close()`.
 */
const ABORT_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.ABORTED,
  'ABORTED',
  'RUNTIME_OPERATION_ABORTED',
  'RUNTIME_CLOSING',
  'RUNTIME_CLOSED',
])

/** Dispatch states a `Provider_Attempt` may honestly report. */
const DISPATCH_STATES: ReadonlySet<string> = new Set(['not-sent', 'sent', 'unknown'])

/**
 * Run the embedding contract and return its checks, without assembling a report.
 *
 * This is the seam `runProviderConformanceSuite` uses to append embedding checks
 * to a generation run: one report, one `schemaVersion`, one set of counts.
 */
export async function collectEmbeddingConformanceChecks(
  fixture: EmbeddingConformanceFixture,
  timeouts: ResolvedConformanceTimeouts,
): Promise<readonly ProviderConformanceCheck[]> {
  const collector = createCheckCollector()
  const { check } = collector
  const budget = timeouts.caseTimeoutMs

  // -- Group 1: mapping and validation (Requirement 17.3) --------------------

  await check('embedding-mapping-index-faithful', async () => {
    const inputs = simpleInputs('reordered')
    const candidate = createCase(fixture, 'embedding-reordered-response', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const result = await within(
        runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
          values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
        }),
        budget,
      )
      assert(result.embeddings.length === inputs.length,
        `a reordered response yielded ${result.embeddings.length} vectors for ${inputs.length} inputs`)
      // Fidelity is only observable when the profile records no transform; a
      // scenario that post-processes cannot answer the question this check asks.
      assert(result.profile.postProcessing === undefined,
        'embedding-reordered-response must declare no post-processing, otherwise vector fidelity is unobservable')
      const produced = candidate.control.providerVectors()
      assert(produced.size === inputs.length,
        `fixture recorded ${produced.size} provider vectors for ${inputs.length} inputs`)
      for (let index = 0; index < inputs.length; index += 1) {
        const expected = produced.get(index)
        const actual = result.embeddings[index]
        assert(expected !== undefined, `fixture recorded no provider vector for input ${index}`)
        assert(actual !== undefined, `no vector was published for input ${index}`)
        assert(sameVector(actual, expected),
          `the vector published at input ${index} is not the vector the provider returned for that index`)
      }
      assertInputsAccounted(result.usage, inputs.length)
    })
  })

  await check('embedding-mapping-invalid-rejected', () => rejectingCase(
    fixture, timeouts, 'embedding-invalid-index', MAPPING_CODES,
    'a response whose vector indexes are not a valid permutation',
  ))

  await check('embedding-vector-validation', () => rejectingCase(
    fixture, timeouts, 'embedding-invalid-vector', VECTOR_CODES,
    'a response carrying an unusable vector',
  ))

  // -- Group 2: batching (Requirement 17.4) ----------------------------------

  let batching: BatchingEvidence | undefined
  await check('embedding-batch-limits-respected', async () => {
    batching = await runBatching(fixture, timeouts)
    const { limits, inputs, snapshot } = batching
    const succeeded = snapshot.dispatches.filter(dispatch => !dispatch.failed)
    assert(succeeded.length >= 2,
      'the batching corpus was sent as a single batch, so no bound was exercised')
    const seen: number[] = []
    for (const dispatch of succeeded) {
      const size = dispatch.itemIndexes.length
      assert(size >= 1, 'a batch was dispatched carrying no item')
      assert(size <= limits.maxItems,
        `a batch carried ${size} items, over the declared bound of ${limits.maxItems}`)
      // A lone item that exceeds a bound on its own is a deliberate exception:
      // the SDK splits, it never cuts content to fit.
      if (size > 1) {
        const tokens = dispatch.itemIndexes.reduce(
          (sum, index) => sum + estimateTokens(inputs[index] ?? ''), 0,
        )
        const bytes = dispatch.itemIndexes.reduce(
          (sum, index) => sum + byteLength(inputs[index] ?? ''), 0,
        )
        assert(tokens <= limits.maxTokens,
          `a multi-item batch estimated ${tokens} tokens, over the declared bound of ${limits.maxTokens}`)
        assert(bytes <= limits.maxBytes,
          `a multi-item batch carried ${bytes} content bytes, over the declared bound of ${limits.maxBytes}`)
      }
      seen.push(...dispatch.itemIndexes)
    }
    assert(seen.every(index => Number.isInteger(index) && index >= 0 && index < inputs.length),
      'a batch carried an item index outside the logical call')
    assert(seen.length === inputs.length && new Set(seen).size === inputs.length,
      `batching placed ${seen.length} item slots for ${inputs.length} inputs; each input belongs to exactly one batch`)
  })

  await check('embedding-batch-memory-bounded', () => {
    const evidence = required(batching)
    const { snapshot, concurrency, limits, inputs, corpusBytes } = evidence
    assert(snapshot.peakInFlight >= 1, 'fixture reported no in-flight attempt at all')
    assert(snapshot.peakInFlight <= concurrency,
      `${snapshot.peakInFlight} attempts were in flight at once, over the configured bound of ${concurrency}`)
    const windowItems = concurrency * limits.maxItems
    assert(windowItems < inputs.length,
      `the in-flight window of ${windowItems} items covers the whole corpus of ${inputs.length}, so boundedness is untested`)
    assert(snapshot.peakInFlightBytes > 0, 'fixture reported no in-flight payload bytes')
    assert(snapshot.peakInFlightBytes < corpusBytes,
      `peak in-flight payload of ${snapshot.peakInFlightBytes} bytes reached the whole corpus of ${corpusBytes}; `
      + 'memory of one logical call must not scale with the corpus')
  })

  // -- Group 3: cancellation and close (Requirement 17.5) -------------------

  await check('embedding-abort-stops-unsent', async () => {
    const inputs = corpusInputs('abort')
    const candidate = createCase(fixture, 'embedding-abort-in-flight', inputs)
    const limits = declaredLimits(candidate, inputs.length)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const controller = new AbortController()
      const call = runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose, signal: controller.signal,
      })
      await within(dispatchBarrier(candidate), budget)
      controller.abort()
      const failure = await rejectionOf(call, budget, 'an aborted embedding call')
      const code = codeOf(failure)
      assert(ABORT_CODES.has(code), `an aborted call surfaced "${code}" instead of a stable abort code`)
      const snapshot = candidate.control.snapshot()
      const sent = new Set(snapshot.dispatches.flatMap(dispatch => [...dispatch.itemIndexes]))
      assert(sent.size < inputs.length,
        'every input reached the provider despite the abort; unsent batches must stay unsent')
      const planned = Math.ceil(inputs.length / limits.maxItems)
      assert(snapshot.dispatches.length <= planned,
        `${snapshot.dispatches.length} attempts were spent for a call that plans ${planned} batches`)
    })
  })

  await check('embedding-close-covers-operation', async () => {
    const inputs = corpusInputs('close')
    const candidate = createCase(fixture, 'embedding-abort-in-flight', inputs)
    const runtime = await startRuntime(candidate, timeouts)
    let report: RuntimeCloseReport | undefined
    let observed: Promise<unknown> | undefined
    try {
      const call = runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      })
      // Observed immediately, so closing never sees an unhandled rejection.
      observed = call.then(() => undefined, (error: unknown) => error)
      await within(dispatchBarrier(candidate), budget)
    } finally {
      report = await within(runtime.close(), timeouts.closeTimeoutMs + budget)
      const again = await runtime.close()
      assert(report === again, 'a second close produced a different report')
    }
    const closed = required(report)
    assert(closed.state === 'closed', 'the runtime did not reach the closed state')
    const summary = closed.operations.find(row => row.kind === 'embedding-call')
    assert(summary !== undefined, 'the close report carries no summary for the embedding operation kind')
    assert(summary.activeAtClose >= 1, 'the in-flight embedding call was not counted at close')
    for (const row of closed.operations) {
      assert(row.settled + row.unsettled === row.activeAtClose,
        `the close summary for "${row.kind}" does not balance against activeAtClose`)
    }
    assert(summary.aborted === summary.activeAtClose,
      'a live embedding call survived close without being aborted')
    const failure = await within(required(observed), budget)
    assert(failure !== undefined, 'an embedding call resolved after the runtime closed')
    const code = codeOf(failure)
    assert(ABORT_CODES.has(code), `close ended the call with "${code}" instead of a stable abort code`)
    assert(candidate.control.snapshot().cleanupCalls === 1, 'embedding provider cleanup count is not one')
  })

  // -- Group 4: retry and cost (Requirement 17.6) ---------------------------

  await check('embedding-retry-no-resend', async () => {
    const inputs = simpleInputs('retry')
    const candidate = createCase(fixture, 'embedding-retry-cost', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      // Either terminal outcome is a legitimate retry script, so the outcome
      // itself is not the claim; the attempt ledger is.
      await settled(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      const snapshot = candidate.control.snapshot()
      assert(snapshot.dispatches.length >= 2,
        'the retry scenario spent a single attempt, so no retry was exercised')
      for (const [signature, rows] of groupBySignature(snapshot.dispatches)) {
        const succeeded = rows.filter(row => !row.failed)
        assert(succeeded.length <= 1,
          `batch [${signature}] succeeded ${succeeded.length} times; a succeeded batch is never dispatched again`)
        if (succeeded.length === 1) {
          assert(rows.at(-1)?.failed === false,
            `batch [${signature}] was dispatched again after it had already succeeded`)
        }
      }
      const expected = candidate.expectedAttempts
      if (expected !== undefined) {
        assert(snapshot.dispatches.length === expected,
          `the scenario spent ${snapshot.dispatches.length} attempts, not the declared ${expected}`)
      }
    })
  })

  await check('embedding-timeout-dispatch-unknown', async () => {
    const inputs = simpleInputs('timeout')
    const candidate = createCase(fixture, 'embedding-retry-cost', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      await settled(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      const ends = runtime.diagnostics().events.filter(
        event => event.name === 'sdk.provider.attempt' && event.phase === 'end',
      )
      assert(ends.length >= 1,
        'no provider attempt was recorded; an embedding attempt must report through the attempt ledger')
      const states = ends.map(event => String(event.data.dispatchState))
      for (const state of states) {
        assert(DISPATCH_STATES.has(state), `an attempt recorded the unrecognised dispatch state "${state}"`)
      }
      assert(states.includes('unknown'),
        'no attempt recorded dispatch state "unknown"; a request that never returned must not claim to know '
        + 'whether it reached the provider')
    })
  })

  // -- Group 5: cache (Requirement 17.7) ------------------------------------

  await check('embedding-cache-key-composition', async () => {
    const inputs = simpleInputs('cache')
    const candidate = createCase(fixture, 'embedding-cache-key', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const store = recordingStore()
      const scoped = { store, scope: EMBEDDING_CONFORMANCE_DEFAULTS.cacheScope }
      const embed = async (
        label: string,
        overrides: Partial<EmbeddingModelOptions>,
        values: readonly string[],
        purpose: EmbeddingPurpose,
      ) => {
        const before = candidate.control.snapshot().dispatches.length
        const result = await within(
          runtime.embeddingModel(embeddingOptions(candidate, { cache: scoped, ...overrides }))
            .embedMany({ values, purpose }),
          budget,
        )
        const after = candidate.control.snapshot().dispatches.length
        return { label, result, dispatched: after - before }
      }

      const first = await embed('the first call', {}, inputs, EMBEDDING_CONFORMANCE_DEFAULTS.purpose)
      assert(first.result.usage.inputsFromCache === 0,
        'the first call reported cache hits against an empty cache')
      assert(first.result.usage.inputsFromProvider === inputs.length,
        'the first call did not send every input to the provider')
      assert(store.written().length === inputs.length,
        `the cache stored ${store.written().length} entries for ${inputs.length} inputs`)

      const repeat = await embed('an identical repeat', {}, inputs, EMBEDDING_CONFORMANCE_DEFAULTS.purpose)
      assert(repeat.result.usage.inputsFromCache === inputs.length,
        'an identical repeat call did not hit the cache for every input')
      assert(repeat.dispatched === 0, 'a fully cached call still reached the provider')
      assert(repeat.result.embeddings.every((vector, index) => sameVector(vector, first.result.embeddings[index] ?? [])),
        'the cached vectors differ from the ones the call first published')

      // Each component of Requirement 5.2 must move the key on its own: if any
      // one of them did not, two different questions would share one answer.
      const misses = [
        await embed('the security scope',
          { cache: { store, scope: EMBEDDING_CONFORMANCE_DEFAULTS.alternateCacheScope } },
          inputs, EMBEDDING_CONFORMANCE_DEFAULTS.purpose),
        await embed('the purpose', {}, inputs, EMBEDDING_CONFORMANCE_DEFAULTS.alternatePurpose),
        await embed('the input content', {},
          inputs.map(value => `${value} revised`), EMBEDDING_CONFORMANCE_DEFAULTS.purpose),
        ...(candidate.alternateDimensions === undefined ? [] : [
          await embed('the dimensions', { dimensions: candidate.alternateDimensions },
            inputs, EMBEDDING_CONFORMANCE_DEFAULTS.purpose),
        ]),
      ]
      for (const miss of misses) {
        assert(miss.result.usage.inputsFromCache === 0, `changing ${miss.label} still hit the cache`)
        assert(miss.dispatched >= 1, `changing ${miss.label} produced no new provider batch`)
      }
    })
  })

  // -- Group 6: compatibility (Requirement 17.8) ----------------------------

  await check('embedding-space-guard', async () => {
    const inputs = simpleInputs('space')
    const candidate = createCase(fixture, 'embedding-space-mismatch', inputs)
    const foreign = requiredSpace(candidate)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const before = candidate.control.snapshot().dispatches.length
      const failure = await rejectionOf(
        Promise.resolve().then(() => runtime
          .embeddingModel(embeddingOptions(candidate, { expectedSpace: foreign }))
          .embed({ value: probe(inputs), purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose })),
        budget,
        'a call whose expected embedding space is incompatible',
      )
      const code = codeOf(failure)
      assert(code === EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE,
        `an incompatible expected space was reported as "${code}"`)
      assert(candidate.control.snapshot().dispatches.length === before,
        'an incompatible embedding space still reached the provider')
    })
  })

  await check('embedding-no-model-fallback', async () => {
    const inputs = simpleInputs('fallback')
    const candidate = createCase(fixture, 'embedding-space-mismatch', inputs)
    const foreign = requiredSpace(candidate)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const rejected = await rejectionOf(
        Promise.resolve().then(() => runtime
          .embeddingModel(embeddingOptions(candidate, { expectedSpace: foreign }))
          .embed({ value: probe(inputs), purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose })),
        budget,
        'a call whose expected embedding space is incompatible',
      )
      assert(codeOf(rejected) === EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE,
        'the incompatible call did not fail on space identity')
      const own = await within(runtime.embeddingModel(embeddingOptions(candidate)).embed({
        value: probe(inputs), purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      if (candidate.foreignModel !== undefined) {
        const other = await within(runtime
          .embeddingModel(embeddingOptions(candidate, { model: candidate.foreignModel }))
          .embed({ value: probe(inputs), purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose }), budget)
        assert(other.space !== own.space,
          'the two declared model generations resolved to one embedding space, so the scenario cannot show '
          + 'that no fallback exists')
      }
      const allowed = new Set([candidate.model, ...(candidate.foreignModel === undefined ? [] : [candidate.foreignModel])])
      const foreignDispatch = candidate.control.snapshot().dispatches.find(row => !allowed.has(row.model))
      assert(foreignDispatch === undefined,
        'a request went out under a model the caller never asked for; there is no fallback across embedding spaces')
    })
  })

  // -- Group 7: plugin compatibility (Requirement 17.9) --------------------

  await check('embedding-plugin-generation-only', async () => {
    const inputs = simpleInputs('generation-only')
    const candidate = createCase(fixture, 'generation-only-plugin', inputs)
    assert(candidate.plugin.kind === 'model-provider-plugin',
      'the generation-only scenario must supply a model provider plugin')
    await withRuntime(candidate, timeouts, (runtime) => {
      assert(runtime.providers().length >= 1, 'a generation-only runtime advertised no provider')
      let code = 'NONE'
      try {
        runtime.embeddingModel(embeddingOptions(candidate))
      } catch (error) {
        code = codeOf(error)
      }
      assert(code === EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
        `a route with no embedding adapter reported "${code}" instead of EMBEDDING_ADAPTER_MISSING`)
      assert(candidate.control.snapshot().dispatches.length === 0,
        'a generation-only runtime dispatched an embedding batch')
      return Promise.resolve()
    })
  })

  await check('embedding-plugin-embedding-only', async () => {
    const inputs = simpleInputs('embedding-only')
    const candidate = createCase(fixture, 'embedding-only-runtime', inputs)
    assert(candidate.plugin.kind === 'embedding-provider-plugin',
      'the embedding-only scenario must supply an embedding provider plugin')
    const runtime = await startRuntime(candidate, timeouts)
    let report: RuntimeCloseReport | undefined
    try {
      const result = await within(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      assert(result.embeddings.length === inputs.length,
        'a runtime carrying only an embedding plugin did not produce a vector per input')
      assert(typeof result.space === 'string' && result.space.length > 0,
        'the result of an embedding-only runtime carries no Space_Id')
    } finally {
      report = await within(runtime.close(), timeouts.closeTimeoutMs + budget)
      await runtime.close()
    }
    assert(required(report).state === 'closed',
      'a runtime carrying only an embedding plugin did not close cleanly')
    assert(candidate.control.snapshot().cleanupCalls === 1, 'embedding provider cleanup count is not one')
  })

  // -- Group 8: usage honesty (Requirements 16.2, 16.3) --------------------

  await check('embedding-usage-honesty', async () => {
    const inputs = simpleInputs('usage')
    const candidate = createCase(fixture, 'embedding-missing-usage', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const result = await within(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      const { usage } = result
      assert(usage.status === 'missing' || usage.status === 'partial',
        `usage the provider did not report was published as "${usage.status}"`)
      if (usage.status === 'missing') {
        assert(usage.tokens === undefined, 'a call with no readable usage still published token counts')
      }
      assert(usage.tokens?.inputTokens !== 0, 'an unreported input count was published as zero')
      assert(usage.batches >= 1, 'usage recorded no batch for work that was dispatched')
      assert(usage.providerAttempts >= 1, 'usage recorded no provider attempt for work that was dispatched')
      assert(usage.batchesWithUsage <= usage.batches,
        `${usage.batchesWithUsage} batches reported usage but only ${usage.batches} were dispatched`)
      assertInputsAccounted(usage, inputs.length)
      assert(result.warnings.some(warning => warning.code === 'usage-unreported' || warning.code === 'usage-malformed'),
        'unusable provider usage produced no warning')
    })
  })

  // -- Group 9: privacy (Requirement 17.10) --------------------------------

  await check('embedding-trace-privacy', async () => {
    const inputs = simpleInputs('privacy')
    const candidate = createCase(fixture, 'embedding-success', inputs)
    await withRuntime(candidate, timeouts, async (runtime) => {
      const result = await within(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }), budget)
      assert(result.embeddings.length === inputs.length,
        'the success scenario did not produce a vector per input')
      const diagnostics = runtime.diagnostics()
      const serialized = JSON.stringify(diagnostics)
      assert(!serialized.includes(EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel),
        'raw document content crossed the observation privacy boundary')
      assert(!serialized.includes(PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel),
        'a private provider value crossed the observation privacy boundary')
      // Only distinctive renderings are searched: a short value like `1` would
      // collide with a count or a duration and make this test lie.
      for (const value of result.embeddings[0] ?? []) {
        const rendered = String(value)
        if (rendered.length < 8) continue
        assert(!serialized.includes(rendered), 'a raw vector value crossed the observation privacy boundary')
      }
      const names = new Set(diagnostics.events.map(event => event.name))
      assert(names.has('sdk.embedding.call'), 'no logical embedding call was recorded')
      assert(names.has('sdk.embedding.batch'), 'no physical batch was recorded')
      assert(names.has('sdk.provider.attempt'), 'no provider attempt was recorded')
    })
  })

  return collector.checks
}

/**
 * Execute the embedding contract on its own.
 *
 * For a provider whose embedding capability ships separately from its generation
 * capability — which is the normal shape, since `Embedding_Provider_Plugin` is
 * its own plugin kind. The report is the same structure, with the embedding
 * checks in `checks`.
 */
export async function runEmbeddingConformanceSuite(
  fixture: EmbeddingConformanceFixture,
  options: ProviderConformanceOptions = {},
): Promise<ProviderConformanceReport> {
  const checks = await collectEmbeddingConformanceChecks(fixture, resolveTimeouts(options))
  const report = assembleReport(checks)
  if (report.failed > 0) throw new ProviderConformanceError(report)
  return report
}

// ---------------------------------------------------------------------------
// Case construction
// ---------------------------------------------------------------------------

function simpleInputs(label: string): readonly string[] {
  return embeddingConformanceInputs(EMBEDDING_CONFORMANCE_DEFAULTS.inputCount, label)
}

function corpusInputs(label: string): readonly string[] {
  return embeddingConformanceInputs(EMBEDDING_CONFORMANCE_DEFAULTS.corpusCount, label)
}

/** First input, used where one probe vector is enough. */
function probe(inputs: readonly string[]): string {
  return inputs[0] ?? `${EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel} probe`
}

/**
 * Build one case and hold the fixture to the identity it was asked for.
 *
 * Also the inert-construction claim for embedding: creating a provider instance
 * must perform no setup, no cleanup and no dispatch.
 */
function createCase(
  fixture: EmbeddingConformanceFixture,
  scenario: EmbeddingConformanceScenario,
  inputs: readonly string[],
  purpose: EmbeddingPurpose = EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
): EmbeddingConformanceCase {
  const id = `embedding-case-${scenario}`
  const route = `embedding-route-${scenario}`
  const value = fixture.create({
    scenario, id, route, inputs, purpose,
    privateSentinel: PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel,
  })
  assert(value !== null && typeof value === 'object', 'embedding fixture did not return a case')
  assert(value.route === route && value.plugin.id === id, 'embedding fixture changed the requested identity')
  assert(value.plugin.routes.length === 1 && value.plugin.routes[0] === route,
    'embedding fixture changed the requested route')
  assert(typeof value.model === 'string' && value.model.length > 0,
    'embedding fixture returned no model id')
  const snapshot = value.control.snapshot()
  assert(snapshot.setupCalls === 0 && snapshot.cleanupCalls === 0 && snapshot.dispatches.length === 0,
    'embedding fixture performed provider work at construction time')
  return value
}

function embeddingOptions(
  candidate: EmbeddingConformanceCase,
  overrides: Partial<EmbeddingModelOptions> = {},
): EmbeddingModelOptions {
  return {
    provider: candidate.route,
    model: candidate.model,
    ...(candidate.dimensions === undefined ? {} : { dimensions: candidate.dimensions }),
    ...(candidate.concurrency === undefined ? {} : { concurrency: candidate.concurrency }),
    ...(candidate.batchLimits === undefined ? {} : { batchLimits: candidate.batchLimits }),
    ...overrides,
  }
}

async function startRuntime(
  candidate: EmbeddingConformanceCase,
  timeouts: ResolvedConformanceTimeouts,
): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime({
    providers: [candidate.plugin],
    startupTimeoutMs: timeouts.startupTimeoutMs,
    closeTimeoutMs: timeouts.closeTimeoutMs,
  })
  assert(candidate.control.snapshot().setupCalls === 1, 'embedding provider setup count is not one')
  return runtime
}

/** Start a runtime for one case, run the task, then close it twice. */
async function withRuntime(
  candidate: EmbeddingConformanceCase,
  timeouts: ResolvedConformanceTimeouts,
  task: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await startRuntime(candidate, timeouts)
  try {
    await task(runtime)
  } finally {
    await runtime.close()
    await runtime.close()
  }
  assert(candidate.control.snapshot().cleanupCalls === 1, 'embedding provider cleanup count is not one')
}

/** The batch bounds a batching scenario must declare, with the reason they matter. */
function declaredLimits(
  candidate: EmbeddingConformanceCase,
  inputCount: number,
): { readonly maxItems: number; readonly maxTokens: number; readonly maxBytes: number } {
  const limits = candidate.batchLimits
  assert(limits !== undefined
    && limits.maxItems !== undefined && limits.maxTokens !== undefined && limits.maxBytes !== undefined,
  'a batching scenario must declare maxItems, maxTokens and maxBytes explicitly')
  assert(limits.maxItems < inputCount,
    `the declared maxItems of ${limits.maxItems} covers the whole corpus of ${inputCount} inputs`)
  return { maxItems: limits.maxItems, maxTokens: limits.maxTokens, maxBytes: limits.maxBytes }
}

function declaredConcurrency(candidate: EmbeddingConformanceCase): number {
  const value = candidate.concurrency
  assert(value !== undefined && Number.isInteger(value) && value > 0,
    'a batching scenario must declare a positive concurrency')
  return value
}

function requiredSpace(candidate: EmbeddingConformanceCase): EmbeddingSpaceId {
  const space = candidate.incompatibleSpace
  assert(space !== undefined && String(space).length > 0,
    'a compatibility scenario must declare an incompatible Space_Id')
  return space
}

function dispatchBarrier(candidate: EmbeddingConformanceCase): Promise<void> {
  const entered = candidate.control.waitForDispatch?.()
  assert(entered !== undefined, 'this scenario has no dispatch barrier; abort would be a race')
  return entered
}

// ---------------------------------------------------------------------------
// Shared scenario bodies
// ---------------------------------------------------------------------------

interface BatchingEvidence {
  readonly limits: { readonly maxItems: number; readonly maxTokens: number; readonly maxBytes: number }
  readonly concurrency: number
  readonly inputs: readonly string[]
  readonly snapshot: EmbeddingConformanceControlSnapshot
  readonly corpusBytes: number
}

/**
 * One batching run, shared by the two batching checks.
 *
 * Run once rather than twice because the memory claim is about the SAME run that
 * respected the bounds: two runs could each satisfy one half.
 */
async function runBatching(
  fixture: EmbeddingConformanceFixture,
  timeouts: ResolvedConformanceTimeouts,
): Promise<BatchingEvidence> {
  const inputs = corpusInputs('corpus')
  const candidate = createCase(fixture, 'embedding-batch-limits', inputs)
  const limits = declaredLimits(candidate, inputs.length)
  const concurrency = declaredConcurrency(candidate)
  let snapshot: EmbeddingConformanceControlSnapshot | undefined
  await withRuntime(candidate, timeouts, async (runtime) => {
    const result = await within(runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
      values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
    }), timeouts.caseTimeoutMs)
    assert(result.embeddings.length === inputs.length,
      `a batched call published ${result.embeddings.length} vectors for ${inputs.length} inputs`)
    snapshot = candidate.control.snapshot()
  })
  return Object.freeze({
    limits,
    concurrency,
    inputs,
    snapshot: required(snapshot),
    corpusBytes: inputs.reduce((sum, text) => sum + byteLength(text), 0),
  })
}

/**
 * A scenario whose response breaks the contract: it must fail, with a code from
 * `allowed`, and with the exact code the fixture declared.
 *
 * Two assertions rather than one on purpose. Membership in `allowed` is the
 * taxonomy claim — both providers report mapping faults from the same small set.
 * Equality with `expectedFailureCode` is the fixture's own claim about which one,
 * and it is what catches a provider that reports a plausible-but-wrong code.
 */
async function rejectingCase(
  fixture: EmbeddingConformanceFixture,
  timeouts: ResolvedConformanceTimeouts,
  scenario: EmbeddingConformanceScenario,
  allowed: ReadonlySet<string>,
  label: string,
): Promise<void> {
  const inputs = simpleInputs(scenario)
  const candidate = createCase(fixture, scenario, inputs)
  await withRuntime(candidate, timeouts, async (runtime) => {
    const failure = await rejectionOf(
      runtime.embeddingModel(embeddingOptions(candidate)).embedMany({
        values: inputs, purpose: EMBEDDING_CONFORMANCE_DEFAULTS.purpose,
      }),
      timeouts.caseTimeoutMs,
      label,
    )
    const code = codeOf(failure)
    assert(allowed.has(code), `${label} was reported as "${code}", outside the embedding fault taxonomy`)
    const expected = candidate.expectedFailureCode
    assert(typeof expected === 'string' && expected.length > 0,
      `the "${scenario}" fixture declared no expected failure code`)
    assert(code === expected, `${label} reported "${code}" where the fixture expects "${expected}"`)
    assert(!messageOf(failure).includes(PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel),
      'a private provider value crossed the failure boundary')
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return ENCODER.encode(text).byteLength
}

function sameVector(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** Every input is accounted for exactly once, by the cache or by the provider. */
function assertInputsAccounted(
  usage: { readonly inputsFromCache: number; readonly inputsFromProvider: number },
  inputCount: number,
): void {
  const total = usage.inputsFromCache + usage.inputsFromProvider
  assert(total === inputCount,
    `usage accounts for ${total} inputs in a call of ${inputCount}; cache and provider counts must sum to the call`)
}

/** The stable code of a rejection, without trusting the value's shape. */
function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    try {
      const code = Reflect.get(error, 'code')
      if (typeof code === 'string' && code.length > 0) return code
    } catch {
      return 'UNREADABLE'
    }
  }
  return 'UNKNOWN'
}

/** The message of a rejection, for the one privacy assertion that needs it. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    try {
      const message = Reflect.get(error, 'message')
      if (typeof message === 'string') return message
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The value a promise rejected with.
 *
 * A timeout is re-thrown rather than returned: a case that never settled is not
 * evidence that the call was rejected.
 */
async function rejectionOf<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<unknown> {
  try {
    await within(promise, timeoutMs)
  } catch (error) {
    if (error instanceof ConformanceTimeoutError) throw error
    return error
  }
  throw new ConformanceAssertionError(`${what} unexpectedly succeeded`)
}

/** Await a call whose outcome is not the claim under test. */
async function settled<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  try {
    await within(promise, timeoutMs)
  } catch (error) {
    if (error instanceof ConformanceTimeoutError) throw error
  }
}

/** Attempts grouped by the exact item set they carried. */
function groupBySignature(
  dispatches: readonly EmbeddingConformanceDispatch[],
): ReadonlyMap<string, readonly EmbeddingConformanceDispatch[]> {
  const groups = new Map<string, EmbeddingConformanceDispatch[]>()
  for (const dispatch of dispatches) {
    const signature = [...dispatch.itemIndexes].join(',')
    const rows = groups.get(signature) ?? []
    rows.push(dispatch)
    groups.set(signature, rows)
  }
  return groups
}

interface RecordingCacheStore extends EmbeddingCacheStore {
  /** Keys written, in write order. */
  written(): readonly string[]
}

/**
 * An in-process cache that also records what it was asked to store.
 *
 * The harness owns the store rather than the fixture: cache-key composition is a
 * runtime claim, and a provider-supplied store could satisfy it accidentally.
 */
function recordingStore(): RecordingCacheStore {
  const entries = new Map<string, EmbeddingCacheEntry>()
  const written: string[] = []
  return {
    get: (key: string) => entries.get(key),
    set: (key: string, entry: EmbeddingCacheEntry) => {
      entries.set(key, entry)
      written.push(key)
    },
    written: () => [...written],
  }
}
