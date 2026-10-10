import {
  assert,
  within,
  required,
} from '../report.ts'
import {
  EMBEDDING_CONFORMANCE_DEFAULTS,
} from './config.ts'
import {
  simpleInputs,
  createCase,
  embeddingOptions,
  withRuntime,
  rejectingCase,
  runBatching,
} from './case-support.ts'
import {
  sameVector,
  assertInputsAccounted,
  byteLength,
} from './check-support.ts'
import {
  type CheckContext,
  MAPPING_CODES,
  VECTOR_CODES,
} from './check-context.ts'
import {
  estimateTokens,
} from '@alvin0/ai-agent-sdk-core/embedding'

export async function checkMappingIndexFaithful(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
}

export async function checkMappingInvalidRejected(context: CheckContext) {
  const { check, fixture, timeouts } = context
  await check('embedding-mapping-invalid-rejected', () => rejectingCase(
    fixture, timeouts, 'embedding-invalid-index', { allowed: MAPPING_CODES,
      label: 'a response whose vector indexes are not a valid permutation' },
  ))
}

export async function checkVectorValidation(context: CheckContext) {
  const { check, fixture, timeouts } = context
  await check('embedding-vector-validation', () => rejectingCase(
    fixture, timeouts, 'embedding-invalid-vector', { allowed: VECTOR_CODES,
      label: 'a response carrying an unusable vector' },
  ))
}

export async function checkBatchLimitsRespected(context: CheckContext) {
  const { check, fixture, timeouts } = context
  await check('embedding-batch-limits-respected', async () => {
    context.batching = await runBatching(fixture, timeouts)
    const { limits, inputs, snapshot } = context.batching
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
}

export async function checkBatchMemoryBounded(context: CheckContext) {
  const { check } = context
  await check('embedding-batch-memory-bounded', () => {
    const evidence = required(context.batching)
    const { snapshot, concurrency, limits, inputs, corpusBytes } = evidence
    assert(snapshot.peakInFlight >= 1, 'fixture reported no in-flight attempt at all')
    assert(snapshot.peakInFlight <= concurrency,
      `${snapshot.peakInFlight} attempts were in flight at once, over the configured bound of ${concurrency}`)
    const windowItems = concurrency * limits.maxItems
    assert(windowItems < inputs.length,
      `the in-flight window of ${windowItems} items covers the whole corpus of ${inputs.length}, `
      + `so boundedness is untested`)
    assert(snapshot.peakInFlightBytes > 0, 'fixture reported no in-flight payload bytes')
    assert(snapshot.peakInFlightBytes < corpusBytes,
      `peak in-flight payload of ${snapshot.peakInFlightBytes} bytes reached the whole corpus of ${corpusBytes}; `
      + 'memory of one logical call must not scale with the corpus')
  })
}
