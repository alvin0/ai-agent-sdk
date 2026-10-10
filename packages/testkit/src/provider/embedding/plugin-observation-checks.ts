import {
  EMBEDDING_ERROR_CODES,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  assert,
  required,
  within,
} from '../report.ts'
import {
  simpleInputs,
  createCase,
  embeddingOptions,
  withRuntime,
  startRuntime,
} from './case-support.ts'
import {
  codeOf,
  assertInputsAccounted,
} from './check-support.ts'
import {
  type CheckContext,
} from './check-context.ts'
import {
  type RuntimeCloseReport,
} from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_CONFORMANCE_DEFAULTS,
} from './config.ts'
import {
  PROVIDER_CONFORMANCE_DEFAULTS,
} from '../config.ts'

export async function checkPluginGenerationOnly(context: CheckContext) {
  const { check, fixture, timeouts } = context
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
}

export async function checkPluginEmbeddingOnly(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
}

export async function checkUsageHonesty(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
}

export async function checkTracePrivacy(context: CheckContext) {
  const { check, fixture, timeouts, budget } = context
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
}
