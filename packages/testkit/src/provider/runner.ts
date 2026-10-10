export { ProviderConformanceError } from './report.ts'
import type { ExecutedCase } from './generation-support.ts'
import {
  createAgentRuntime,
} from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin  } from '@alvin0/ai-agent-sdk-core/provider'
import { collectEmbeddingConformanceChecks  } from './embedding/runner.ts'
import {
  ProviderConformanceError,
  assembleReport,
  assert,
  createCheckCollector,
  required,
  resolveTimeouts,
  within,
  type ResolvedConformanceTimeouts,
} from './report.ts'
import type {
  ProviderConformanceFixture,
  ProviderConformanceOptions,
  ProviderConformanceReport,
} from './types.ts'

import {
  capture,
  execute,
  withRuntime,
  rejectsConstruction,
  createCase,
  agentDefinition,
  assertCompleteUsage,
  assertRetry,
  assertMissing,
  assertMalformed,
  assertExpectedFailure,
  assertPrivateValueAbsent,
  assertObservation,
  assertSnapshot ,
} from './generation-support.ts'
type ResolvedOptions = ResolvedConformanceTimeouts

export async function runProviderConformanceSuite(
  fixture: ProviderConformanceFixture,
  options: ProviderConformanceOptions = {},
): Promise<ProviderConformanceReport> {
  const resolved = resolveTimeouts(options)
  const collector = createCheckCollector()
  const { checks } = collector

  await collectPreflightChecks(fixture, resolved, collector)
  await collectInvocationChecks(fixture, resolved, collector)
  await collectCleanupChecks(fixture, resolved, collector)

  if (options.embedding !== undefined) {
    checks.push(...await collectEmbeddingConformanceChecks(options.embedding, resolved))
  }

  const report = assembleReport(checks)
  if (report.failed > 0) throw new ProviderConformanceError(report)
  return report
}

async function collectPreflightChecks(
  fixture: ProviderConformanceFixture, resolved: ResolvedOptions, collector: ReturnType<typeof createCheckCollector>,
) {
  const { check } = collector
  await check('inert-construction', () => {
    const candidate = createCase(fixture, 'success', 'inert', 'inert-route')
    assertSnapshot(candidate.control.snapshot(), 0, 0, 0)
  })
  await check('marker-kind-preflight', async () => {
    const candidate = createCase(fixture, 'success', 'wrong-kind', 'wrong-kind-route')
    await rejectsConstruction({ ...candidate.plugin, kind: 'wrong-provider-kind' } as never, resolved)
    assertSnapshot(candidate.control.snapshot(), 0, 0, 0)
  })
  await check('marker-version-preflight', async () => {
    const candidate = createCase(fixture, 'success', 'wrong-version', 'wrong-version-route')
    await rejectsConstruction({ ...candidate.plugin, apiVersion: 2 } as never, resolved)
    assertSnapshot(candidate.control.snapshot(), 0, 0, 0)
  })
  await check('duplicate-route-preflight', async () => {
    const first = createCase(fixture, 'success', 'duplicate-a', 'shared-route')
    const second = createCase(fixture, 'success', 'duplicate-b', 'shared-route')
    await rejectsConstruction([first.plugin, second.plugin], resolved)
    assertSnapshot(first.control.snapshot(), 0, 0, 0)
    assertSnapshot(second.control.snapshot(), 0, 0, 0)
  })
  await check('transactional-rollback', async () => {
    const first = createCase(fixture, 'success', 'rollback-first', 'rollback-first-route')
    const failing: ComposableModelProviderPlugin = Object.freeze({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'rollback-failure',
      displayName: 'Rollback failure', routes: Object.freeze(['rollback-failure-route']),
      setup() { throw new Error('testkit rollback trigger') },
    })
    await rejectsConstruction([first.plugin, failing], resolved)
    assertSnapshot(first.control.snapshot(), 1, 1, 0)
  })

}

async function collectInvocationChecks(
  fixture: ProviderConformanceFixture, resolved: ResolvedOptions, collector: ReturnType<typeof createCheckCollector>,
) {
  const { checks, check } = collector
  const success = await capture(checks, 'success-stream-order', () => execute(fixture, 'success', resolved))
  await check('complete-usage', () => assertCompleteUsage(required(success)))
  await check('observation-correlation-privacy', () => assertObservation(required(success)))
  await check('idempotent-cleanup', () => {
    const value = required(success)
    assert(value.sameCloseReport, 'close report identity changed')
    assertSnapshot(value.afterClose, 1, 1, value.afterClose.dispatchCalls)
  })
  await check('retry-success-accounting', async () => assertRetry(
    await execute(fixture, 'retry-success', resolved), 'success',
  ))
  await check('retry-exhaustion-accounting', async () => assertRetry(
    await execute(fixture, 'retry-exhaustion', resolved), 'error',
  ))
  await check('missing-usage-honesty', async () => assertMissing(
    (await execute(fixture, 'missing-usage', resolved)).report,
  ))
  await check('malformed-usage-honesty', async () => assertMalformed(
    (await execute(fixture, 'malformed-usage', resolved)).report,
  ))
  await check('in-flight-cancellation', async () => {
    const value = await execute(fixture, 'abort-in-flight', resolved)
    assert(value.report.status === 'aborted', 'cancelled run was not aborted')
    assert(value.resultStatus === 'rejected', 'cancelled result did not reject')
  })
  let boundedFailure: ExecutedCase | undefined
  await check('bounded-stream-failure', async () => {
    boundedFailure = await execute(fixture, 'stream-bound-failure', resolved)
    assertExpectedFailure(boundedFailure)
  })
  await check('failure-redaction', () => {
    const value = required(boundedFailure)
    assertPrivateValueAbsent([value.events, value.report, value.diagnostics])
  })
}

async function collectCleanupChecks(
  fixture: ProviderConformanceFixture, resolved: ResolvedOptions, collector: ReturnType<typeof createCheckCollector>,
) {
  const { check } = collector
  await check('cleanup-failure-containment', async () => {
    const candidate = createCase(fixture, 'cleanup-failure', 'cleanup-failure', 'cleanup-failure-route')
    const runtime = await createAgentRuntime({ providers: [candidate.plugin],
      startupTimeoutMs: resolved.startupTimeoutMs, closeTimeoutMs: resolved.closeTimeoutMs })
    const first = await within(runtime.close(), resolved.closeTimeoutMs)
    const second = await runtime.close()
    assert(first === second, 'cleanup failure changed close report identity')
    assert(first.components.some(row => row.kind === 'provider-registration'
      && row.status === 'failed'), 'cleanup failure was not retained')
    assert(candidate.control.snapshot().cleanupCalls === 1, 'failed cleanup was retried or skipped')
    assertPrivateValueAbsent([first, runtime.diagnostics()])
  })
  await check('empty-catalog', async () => {
    const candidate = createCase(fixture, 'catalog-empty', 'catalog-empty', 'catalog-empty-route')
    await withRuntime(candidate, resolved, async runtime => {
      const catalog = await runtime.modelCatalog(candidate.route, { refresh: 'force' })
      assert((catalog.state === 'empty' || catalog.state === 'static')
        && catalog.models.length === 0, 'empty catalog state was not explicit')
    })
  })
  await check('failed-catalog-explicit-call', async () => {
    const candidate = createCase(fixture, 'catalog-failure', 'catalog-failure', 'catalog-failure-route')
    await withRuntime(candidate, resolved, async runtime => {
      const catalog = await runtime.modelCatalog(candidate.route, { refresh: 'force' })
      assert(catalog.state === 'unavailable' && catalog.models.length === 0, 'failed catalog was not unavailable')
      const result = await runtime.agent(agentDefinition(candidate)).generate('explicit model remains callable')
      assert(result.report.status === 'success', 'catalog failure blocked explicit invocation')
    })
  })

}

