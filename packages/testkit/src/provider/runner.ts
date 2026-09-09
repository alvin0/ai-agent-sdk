import {
  createAgentRuntime,
  type AgentRuntime,
  type RunReport,
  type RuntimeAgentRunEvent,
} from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { PROVIDER_CONFORMANCE_DEFAULTS } from './config.ts'
import type {
  ProviderConformanceCase,
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderConformanceOptions,
  ProviderConformanceReport,
  ProviderConformanceScenario,
} from './types.ts'

interface ExecutedCase {
  readonly candidate: ProviderConformanceCase
  readonly events: readonly RuntimeAgentRunEvent[]
  readonly report: RunReport
  readonly resultStatus: 'resolved' | 'rejected'
  readonly diagnostics: ReturnType<AgentRuntime['diagnostics']>
  readonly sameCloseReport: boolean
  readonly afterClose: ProviderConformanceControlSnapshot
}

interface ResolvedOptions {
  readonly caseTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly closeTimeoutMs: number
}

class ConformanceAssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'ConformanceAssertionError' }
}

/** Failure containing the complete support-safe result of a conformance run. */
export class ProviderConformanceError extends Error {
  readonly report: ProviderConformanceReport
  constructor(report: ProviderConformanceReport) {
    const failed = report.checks.filter(check => check.status === 'failed').map(check => check.message).join('; ')
    super(`Provider conformance failed: ${failed}`)
    this.name = 'ProviderConformanceError'
    this.report = report
  }
}

/** Execute the provider-author contract without depending on a test framework. */
export async function runProviderConformanceSuite(
  fixture: ProviderConformanceFixture,
  options: ProviderConformanceOptions = {},
): Promise<ProviderConformanceReport> {
  const resolved = resolveOptions(options)
  const checks: ProviderConformanceCheck[] = []
  const check = async (id: ProviderConformanceCheckId, task: () => Promise<void> | void): Promise<void> => {
    try {
      await task()
      checks.push(Object.freeze({ id, status: 'passed', message: passedMessage(id) }))
    } catch (error) {
      checks.push(Object.freeze({ id, status: 'failed', message: failedMessage(id, error) }))
    }
  }

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

  const failed = checks.filter(row => row.status === 'failed').length
  const report: ProviderConformanceReport = Object.freeze({
    schemaVersion: 1,
    status: failed === 0 ? 'passed' : 'failed',
    checks: Object.freeze([...checks]),
    passed: checks.length - failed,
    failed,
  })
  if (failed > 0) throw new ProviderConformanceError(report)
  return report
}

async function capture(
  checks: ProviderConformanceCheck[], id: ProviderConformanceCheckId,
  task: () => Promise<ExecutedCase>,
): Promise<ExecutedCase | undefined> {
  try {
    const value = await task()
    assertStreamOrder(value)
    checks.push(Object.freeze({ id, status: 'passed', message: passedMessage(id) }))
    return value
  } catch (error) {
    checks.push(Object.freeze({ id, status: 'failed', message: failedMessage(id, error) }))
    return undefined
  }
}

async function execute(
  fixture: ProviderConformanceFixture, scenario: ProviderConformanceScenario, options: ResolvedOptions,
): Promise<ExecutedCase> {
  const candidate = createCase(fixture, scenario, `case-${scenario}`, `route-${scenario}`)
  let output!: Omit<ExecutedCase, 'candidate' | 'sameCloseReport' | 'afterClose'>
  let firstClose: unknown
  let secondClose: unknown
  const runtime = await createAgentRuntime({
    providers: [candidate.plugin], startupTimeoutMs: options.startupTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
  })
  try {
    assert(candidate.control.snapshot().setupCalls === 1, 'provider setup count is not one')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.caseTimeoutMs)])
    const handle = runtime.agent(agentDefinition(candidate)).stream(
      PROVIDER_CONFORMANCE_DEFAULTS.prompt, { signal },
    )
    const events: RuntimeAgentRunEvent[] = []
    const draining = (async () => { for await (const event of handle) events.push(event) })()
    if (scenario === 'abort-in-flight') {
      const entered = candidate.control.waitForDispatch?.()
      assert(entered !== undefined, 'abort fixture has no dispatch barrier')
      await within(entered, options.caseTimeoutMs)
      handle.abort()
    }
    const result = await Promise.allSettled([draining, handle.result])
    const report = await within(handle.report, options.caseTimeoutMs)
    output = {
      events: Object.freeze(events), report,
      resultStatus: result[1]?.status === 'fulfilled' ? 'resolved' : 'rejected',
      diagnostics: runtime.diagnostics(),
    }
  } finally {
    firstClose = await runtime.close()
    secondClose = await runtime.close()
  }
  return Object.freeze({
    candidate, ...output,
    sameCloseReport: firstClose === secondClose,
    afterClose: candidate.control.snapshot(),
  })
}

async function withRuntime(
  candidate: ProviderConformanceCase, options: ResolvedOptions,
  task: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  assertSnapshot(candidate.control.snapshot(), 0, 0, 0)
  const runtime = await createAgentRuntime({ providers: [candidate.plugin],
    startupTimeoutMs: options.startupTimeoutMs, closeTimeoutMs: options.closeTimeoutMs })
  try { await task(runtime) } finally { await runtime.close(); await runtime.close() }
  assert(candidate.control.snapshot().cleanupCalls === 1, 'provider cleanup count is not one')
}

async function rejectsConstruction(
  providers: ComposableModelProviderPlugin | readonly ComposableModelProviderPlugin[],
  options: ResolvedOptions,
): Promise<void> {
  let rejected = false
  let runtime: AgentRuntime | undefined
  try {
    runtime = await createAgentRuntime({ providers: Array.isArray(providers) ? providers : [providers],
      startupTimeoutMs: options.startupTimeoutMs, closeTimeoutMs: options.closeTimeoutMs })
  } catch { rejected = true } finally { if (runtime !== undefined) await runtime.close() }
  assert(rejected, 'invalid provider construction unexpectedly succeeded')
}

function createCase(
  fixture: ProviderConformanceFixture, scenario: ProviderConformanceScenario, id: string, route: string,
): ProviderConformanceCase {
  const value = fixture.create({
    scenario, id, route, privateSentinel: PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel,
  })
  assert(value !== null && typeof value === 'object', 'fixture did not return a case')
  assert(value.route === route && value.plugin.id === id, 'fixture changed requested identity')
  assert(value.plugin.routes.length === 1 && value.plugin.routes[0] === route, 'fixture changed requested route')
  return value
}

function agentDefinition(candidate: ProviderConformanceCase) {
  return { id: `agent-${candidate.plugin.id}`, instructions: 'Run provider conformance.',
    model: { provider: candidate.route, id: candidate.model }, compaction: false as const }
}

function assertStreamOrder(value: ExecutedCase): void {
  assert(value.report.status === 'success', 'success scenario did not succeed')
  assert(value.resultStatus === 'resolved', 'success result rejected')
  assert(value.events.length > 0, 'success stream emitted no events')
  assert(value.events.every(event => event.runId === value.report.runId), 'stream run correlation changed')
  assert(value.events.every((event, index) => index === 0 || event.sequence > value.events[index - 1]!.sequence),
    'stream sequence is not monotonic')
  assert(value.events.some(event => event.type === 'assistant-delta'), 'success stream emitted no assistant delta')
  assert(value.events.at(-1)?.type === 'usage', 'success stream has no terminal usage event')
}

function assertCompleteUsage(value: ExecutedCase): void {
  const expected = value.candidate.expectedTotalTokens
  assert(value.report.usage.authoritative === true, 'complete usage is not authoritative')
  assert(value.report.usage.coverage.complete >= 1, 'complete usage coverage is absent')
  if (expected !== undefined) assert(value.report.usage.reported.totalTokens === expected, 'total usage differs')
}

function assertRetry(value: ExecutedCase, status: 'success' | 'error'): void {
  assert(value.report.status === status, 'retry terminal status differs')
  assert(value.report.modelCalls.length === 1, 'retry created more than one logical call')
  const attempts = value.report.modelCalls[0]!.attempts
  assert(attempts.length === (value.candidate.expectedAttempts ?? 2), 'physical attempt count differs')
  assert(attempts.every((attempt, index) => attempt.attemptNumber === index + 1), 'attempt numbers are unstable')
  if (status === 'success') assert(value.resultStatus === 'resolved', 'retry success rejected')
  else assert(value.resultStatus === 'rejected', 'retry exhaustion resolved')
}

function assertMissing(report: RunReport): void {
  assert(report.usage.authoritative === false, 'missing usage became authoritative')
  assert(report.usage.coverage.missing >= 1, 'missing usage was not recorded')
  assert(report.usage.reported.totalTokens === undefined, 'missing usage became zero/exact total')
}

function assertMalformed(report: RunReport): void {
  assert(report.usage.authoritative === false, 'malformed usage became authoritative')
  assert(report.errors.some(error => error.code === 'USAGE_INVALID'), 'malformed usage defect is absent')
}

function assertExpectedFailure(value: ExecutedCase): void {
  const expected = value.candidate.expectedFailureCode
  assert(typeof expected === 'string' && expected.length > 0, 'bounded stream fixture has no expected failure code')
  assert(value.report.status === 'error', 'bounded stream run did not fail')
  assert(value.resultStatus === 'rejected', 'bounded stream result resolved')
  assert(value.report.errors.some(error => error.code === expected), 'bounded stream failure code is absent')
  assert(value.report.usage.authoritative === false, 'bounded stream failure invented authoritative usage')
}

function assertPrivateValueAbsent(values: readonly unknown[]): void {
  const serialized = JSON.stringify(values)
  assert(!serialized.includes(PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel),
    'private provider failure crossed a support-safe boundary')
}

function assertObservation(value: ExecutedCase): void {
  const serialized = JSON.stringify(value.diagnostics)
  assert(!serialized.includes(PROVIDER_CONFORMANCE_DEFAULTS.prompt), 'prompt crossed observation privacy boundary')
  const events = value.diagnostics.events.filter(event => event.name === 'sdk.model.call')
  assert(events.length === 2, 'model-call lifecycle is unbalanced')
  assert(events.every(event => event.correlation.runId === value.report.runId), 'observation run correlation changed')
}

function assertSnapshot(
  value: ProviderConformanceControlSnapshot, setup: number, cleanup: number, dispatch: number,
): void {
  assert(value.setupCalls === setup && value.cleanupCalls === cleanup && value.dispatchCalls === dispatch,
    'provider lifecycle counters differ')
}

function resolveOptions(options: ProviderConformanceOptions): ResolvedOptions {
  return Object.freeze({
    caseTimeoutMs: positive(options.caseTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.caseTimeoutMs),
    startupTimeoutMs: positive(options.startupTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.startupTimeoutMs),
    closeTimeoutMs: positive(options.closeTimeoutMs ?? PROVIDER_CONFORMANCE_DEFAULTS.closeTimeoutMs),
  })
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Conformance timeouts must be positive finite numbers')
  return value
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('conformance case timed out'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('dependent conformance case failed')
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceAssertionError(message)
}

function passedMessage(id: ProviderConformanceCheckId): string { return `${id} passed` }
function failedMessage(id: ProviderConformanceCheckId, error: unknown): string {
  return error instanceof ConformanceAssertionError ? `${id} failed: ${error.message}` : `${id} failed`
}
