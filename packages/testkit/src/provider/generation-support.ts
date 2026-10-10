import {
  createAgentRuntime,
  type AgentRuntime,
  type RunReport,
  type RuntimeAgentRunEvent,
} from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin  } from '@alvin0/ai-agent-sdk-core/provider'
import { PROVIDER_CONFORMANCE_DEFAULTS  } from './config.ts'
import {
  assert,
  failedMessage,
  passedMessage,
  within,
  type ResolvedConformanceTimeouts,
} from './report.ts'
import type {
  ProviderConformanceCase,
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderGenerationScenario,
} from './types.ts'

export interface ExecutedCase {
  readonly candidate: ProviderConformanceCase
  readonly events: readonly RuntimeAgentRunEvent[]
  readonly report: RunReport
  readonly resultStatus: 'resolved' | 'rejected'
  readonly diagnostics: ReturnType<AgentRuntime['diagnostics']>
  readonly sameCloseReport: boolean
  readonly afterClose: ProviderConformanceControlSnapshot
}

type ResolvedOptions = ResolvedConformanceTimeouts

export { ProviderConformanceError } from './report.ts'

export async function capture(
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

export async function execute(
  fixture: ProviderConformanceFixture, scenario: ProviderGenerationScenario, options: ResolvedOptions,
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

export async function withRuntime(
  candidate: ProviderConformanceCase, options: ResolvedOptions,
  task: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  assertSnapshot(candidate.control.snapshot(), 0, 0, 0)
  const runtime = await createAgentRuntime({ providers: [candidate.plugin],
    startupTimeoutMs: options.startupTimeoutMs, closeTimeoutMs: options.closeTimeoutMs })
  try { await task(runtime) } finally { await runtime.close(); await runtime.close() }
  assert(candidate.control.snapshot().cleanupCalls === 1, 'provider cleanup count is not one')
}

export async function rejectsConstruction(
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

export function createCase(
  fixture: ProviderConformanceFixture, scenario: ProviderGenerationScenario, id: string, route: string,
): ProviderConformanceCase {
  const value = fixture.create({
    scenario, id, route, privateSentinel: PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel,
  })
  assert(value !== null && typeof value === 'object', 'fixture did not return a case')
  assert(value.route === route && value.plugin.id === id, 'fixture changed requested identity')
  assert(value.plugin.routes.length === 1 && value.plugin.routes[0] === route, 'fixture changed requested route')
  return value
}

export function agentDefinition(candidate: ProviderConformanceCase) {
  return { id: `agent-${candidate.plugin.id}`, instructions: 'Run provider conformance.',
    model: { provider: candidate.route, id: candidate.model }, compaction: false as const }
}

export function assertStreamOrder(value: ExecutedCase): void {
  assert(value.report.status === 'success', 'success scenario did not succeed')
  assert(value.resultStatus === 'resolved', 'success result rejected')
  assert(value.events.length > 0, 'success stream emitted no events')
  assert(value.events.every(event => event.runId === value.report.runId), 'stream run correlation changed')
  assert(value.events.every((event, index) => index === 0 || event.sequence > value.events[index - 1]!.sequence),
    'stream sequence is not monotonic')
  assert(value.events.some(event => event.type === 'assistant-delta'), 'success stream emitted no assistant delta')
  assert(value.events.at(-1)?.type === 'usage', 'success stream has no terminal usage event')
}

export function assertCompleteUsage(value: ExecutedCase): void {
  const expected = value.candidate.expectedTotalTokens
  assert(value.report.usage.authoritative === true, 'complete usage is not authoritative')
  assert(value.report.usage.coverage.complete >= 1, 'complete usage coverage is absent')
  if (expected !== undefined) assert(value.report.usage.reported.totalTokens === expected, 'total usage differs')
}

export function assertRetry(value: ExecutedCase, status: 'success' | 'error'): void {
  assert(value.report.status === status, 'retry terminal status differs')
  assert(value.report.modelCalls.length === 1, 'retry created more than one logical call')
  const attempts = value.report.modelCalls[0]!.attempts
  assert(attempts.length === (value.candidate.expectedAttempts ?? 2), 'physical attempt count differs')
  assert(attempts.every((attempt, index) => attempt.attemptNumber === index + 1), 'attempt numbers are unstable')
  if (status === 'success') assert(value.resultStatus === 'resolved', 'retry success rejected')
  else assert(value.resultStatus === 'rejected', 'retry exhaustion resolved')
}

export function assertMissing(report: RunReport): void {
  assert(report.usage.authoritative === false, 'missing usage became authoritative')
  assert(report.usage.coverage.missing >= 1, 'missing usage was not recorded')
  assert(report.usage.reported.totalTokens === undefined, 'missing usage became zero/exact total')
}

export function assertMalformed(report: RunReport): void {
  assert(report.usage.authoritative === false, 'malformed usage became authoritative')
  assert(report.errors.some(error => error.code === 'USAGE_INVALID'), 'malformed usage defect is absent')
}

export function assertExpectedFailure(value: ExecutedCase): void {
  const expected = value.candidate.expectedFailureCode
  assert(typeof expected === 'string' && expected.length > 0, 'bounded stream fixture has no expected failure code')
  assert(value.report.status === 'error', 'bounded stream run did not fail')
  assert(value.resultStatus === 'rejected', 'bounded stream result resolved')
  assert(value.report.errors.some(error => error.code === expected), 'bounded stream failure code is absent')
  assert(value.report.usage.authoritative === false, 'bounded stream failure invented authoritative usage')
}

export function assertPrivateValueAbsent(values: readonly unknown[]): void {
  const serialized = JSON.stringify(values)
  assert(!serialized.includes(PROVIDER_CONFORMANCE_DEFAULTS.failureSentinel),
    'private provider failure crossed a support-safe boundary')
}

export function assertObservation(value: ExecutedCase): void {
  const serialized = JSON.stringify(value.diagnostics)
  assert(!serialized.includes(PROVIDER_CONFORMANCE_DEFAULTS.prompt), 'prompt crossed observation privacy boundary')
  const events = value.diagnostics.events.filter(event => event.name === 'sdk.model.call')
  assert(events.length === 2, 'model-call lifecycle is unbalanced')
  assert(events.every(event => event.correlation.runId === value.report.runId), 'observation run correlation changed')
}

export function assertSnapshot(
  value: ProviderConformanceControlSnapshot, setup: number, cleanup: number, dispatch: number,
): void {
  assert(value.setupCalls === setup && value.cleanupCalls === cleanup && value.dispatchCalls === dispatch,
    'provider lifecycle counters differ')
}


