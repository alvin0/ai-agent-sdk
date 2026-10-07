import {
  type EmbeddingModelOptions,
  type EmbeddingPurpose,
  EMBEDDING_ERROR_CODES,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  assert,
  within,
} from '../report.ts'
import {
  EMBEDDING_CONFORMANCE_DEFAULTS,
} from './config.ts'
import {
  simpleInputs,
  createCase,
  embeddingOptions,
  withRuntime,
  probe,
  requiredSpace,
} from './case-support.ts'
import {
  sameVector,
  recordingStore,
  rejectionOf,
  codeOf,
} from './check-support.ts'
import {
  type CheckContext,
} from './check-context.ts'

export async function checkCacheKeyComposition(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
      assert(repeat.result.embeddings.every((vector, index) =>
        sameVector(vector, first.result.embeddings[index] ?? [])),
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
}

export async function checkSpaceGuard(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
}

export async function checkNoModelFallback(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
      const allowed = new Set([candidate.model,
        ...(candidate.foreignModel === undefined ? [] : [candidate.foreignModel])])
      const foreignDispatch = candidate.control.snapshot().dispatches.find(row => !allowed.has(row.model))
      assert(foreignDispatch === undefined,
        'a request went out under a model the caller never asked for; there is no fallback across embedding spaces')
    })
  })
}
