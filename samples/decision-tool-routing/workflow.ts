import type { DecisionDescription } from '@alvin0/ai-agent-sdk-decision-adapter'
import type { UsageCounters } from '@alvin0/ai-agent-sdk-core/provider'
import { createWorkspace, executeTool, expectedNext, oracle, prerequisites, requiredSources, type Scenario, type Selection, type ToolName, type Workspace } from './domain.ts'

export interface Choice<T extends string> {
  choice: T
  model: string
  usage?: UsageCounters
  probabilities?: Readonly<Record<T, number>>
}
export interface Selector {
  chooseTool(state: DecisionDescription, signal: AbortSignal): Promise<Choice<ToolName>>
  choosePlan(state: DecisionDescription, signal: AbortSignal): Promise<Choice<Selection>>
}
export interface Recommendation {
  recommendation: Selection
  status: 'propose' | 'escalate'
  cost: number | null
  criticalOnTime: number | null
  unmetUnits: number | null
  summary: string
  evidenceIds: string[]
  rejectedPlans: { id: string; reason: string }[]
}
export interface WriterResult { report: Recommendation; usage?: UsageCounters; model: string }
export type Writer = (state: DecisionDescription, signal: AbortSignal) => Promise<WriterResult>
export interface CallRecord {
  kind: 'route' | 'plan' | 'write'
  latencyMs: number
  model?: string
  choice?: string
  expected?: readonly string[]
  correct?: boolean
  probability?: number
  margin?: number
  usage?: UsageCounters
  errorCode?: string
  errorDetail?: string
}
export interface WorkflowResult {
  scenarioId: string
  completed: boolean
  workspace: Workspace
  calls: CallRecord[]
  durationMs: number
  report?: Recommendation
  failure?: string
  failureDetail?: string
}
/** Only stable machine codes are logged; raw upstream errors may contain sensitive data. */
export function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT'
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED'
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/u.test(code) ? code : 'SAMPLE_CALL_FAILED'
}
const safeMessages = new Set([
  'Probabilities must sum to one', 'Choice is not a maximum-probability option',
  'Invalid decision probability', 'Probability options do not match question',
  'Answer selected an unknown option', 'Invalid decision usage counter',
  'Invalid TypeSafe choice answer', 'TypeSafe returned invalid JSON',
  'TypeSafe returned an invalid response object', 'Unexpected TypeSafe answer ids',
  'Missing TypeSafe answer', 'LLM decision generation did not complete successfully',
  'LLM decision fields do not match the requested schema', 'Missing or ambiguous LLM decision output',
  'LLM decision returned invalid JSON', 'Invalid report', 'Writer did not complete', 'Writer returned invalid JSON',
])
export function safeErrorDetail(error: unknown): string | undefined {
  return error instanceof Error && safeMessages.has(error.message) ? error.message : undefined
}
/** Invalid model output is an observed quality failure, not a reason to hide the remaining corpus. */
export function stopsBenchmark(code: string): boolean {
  return !['MALFORMED_RESPONSE', 'INVALID_REPORT', 'WRITER_INCOMPLETE', 'STEP_LIMIT', 'TIMEOUT', 'ABORTED'].includes(code)
}
const jsonState = (value: unknown): DecisionDescription => JSON.parse(JSON.stringify(value)) as DecisionDescription
export function publicState(s: Scenario, w: Workspace): DecisionDescription {
  return jsonState({ request: s.request, coldAlarm: s.coldAlarm, mode: 'analysis_only',
    completedTools: Object.keys(w.observations), observations: w.observations,
    recentErrors: w.trace.filter(event => !event.ok).slice(-3),
    objective: 'Meet ALL hard constraints; minimize total cost among feasible plans. Escalate if no feasible plan exists. Never spend money or send messages.',
  })
}
function evidence<T extends string>(result: Choice<T>): Pick<CallRecord, 'probability' | 'margin'> {
  if (!result.probabilities) return {}
  const values = Object.values(result.probabilities) as number[]
  values.sort((a, b) => b - a)
  return { probability: result.probabilities[result.choice], margin: (values[0] ?? 0) - (values[1] ?? 0) }
}
export async function runWorkflow(s: Scenario, selector: Selector, writer: Writer, options: {
  signal: AbortSignal; maxSteps?: number; onCall?: (record: CallRecord) => void
}): Promise<WorkflowResult> {
  const started = performance.now(), workspace = createWorkspace(), calls: CallRecord[] = []
  const record = (call: CallRecord) => { calls.push(call); options.onCall?.(call) }
  const invoke = async <T extends string>(kind: 'route' | 'plan', expected: readonly string[], operation: () => Promise<Choice<T>>) => {
    const before = performance.now()
    try {
      const result = await operation()
      record({ kind, expected, correct: expected.includes(result.choice), choice: result.choice,
        latencyMs: Math.round(performance.now() - before), model: result.model,
        ...(result.usage ? { usage: result.usage } : {}), ...evidence(result) })
      return result.choice
    } catch (error) {
      const errorDetail = safeErrorDetail(error)
      record({ kind, expected, correct: false, latencyMs: Math.round(performance.now() - before), errorCode: safeErrorCode(error), ...(errorDetail ? { errorDetail } : {}) })
      throw error
    }
  }
  try {
    for (let step = 0; step < (options.maxSteps ?? 16); step++) {
      options.signal.throwIfAborted()
      // expectedNext and oracle are grader-only; their answers never enter publicState.
      const tool = await invoke('route', expectedNext(s, workspace), () => selector.chooseTool(publicState(s, workspace), options.signal))
      let selection: Selection | undefined
      // Check eligibility before spending a nested model call on tool arguments.
      if (tool === 'draft_recommendation' && prerequisites(s, workspace, tool).length === 0) {
        selection = await invoke('plan', oracle(s), () => selector.choosePlan(publicState(s, workspace), options.signal))
      }
      const event = executeTool(s, workspace, tool, selection)
      if (tool !== 'finish' || !event.ok) continue
      const before = performance.now()
      try {
        const result = await writer(publicState(s, workspace), options.signal)
        record({ kind: 'write', latencyMs: Math.round(performance.now() - before), model: result.model, ...(result.usage ? { usage: result.usage } : {}) })
        return { scenarioId: s.id, completed: true, workspace, calls, durationMs: Math.round(performance.now() - started), report: result.report }
      } catch (error) {
        const errorDetail = safeErrorDetail(error)
        record({ kind: 'write', latencyMs: Math.round(performance.now() - before), errorCode: safeErrorCode(error), ...(errorDetail ? { errorDetail } : {}) }); throw error
      }
    }
    return { scenarioId: s.id, completed: false, workspace, calls, durationMs: Math.round(performance.now() - started), failure: 'STEP_LIMIT' }
  } catch (error) {
    const failureDetail = safeErrorDetail(error)
    return { scenarioId: s.id, completed: false, workspace, calls, durationMs: Math.round(performance.now() - started), failure: safeErrorCode(error), ...(failureDetail ? { failureDetail } : {}) }
  }
}

export function grade(s: Scenario, run: WorkflowResult) {
  const report = run.report, routes = run.calls.filter(call => call.kind === 'route')
  const selected = run.workspace.assessments?.find(p => p.id === run.workspace.selection)
  const outcomeCorrect = run.workspace.selection !== undefined && oracle(s).includes(run.workspace.selection)
  const recommendationFaithful = report !== undefined && report.recommendation === run.workspace.selection
  const factsCorrect = !!report && (run.workspace.selection === 'escalate'
    ? report.status === 'escalate' && report.cost === null && report.criticalOnTime === null && report.unmetUnits === null
    : !!selected && report.status === 'propose' && report.cost === selected.cost && report.criticalOnTime === selected.criticalOnTime && report.unmetUnits === selected.unmetUnits)
  const needed = [...requiredSources(s), 'simulate_plans', 'draft_recommendation']
  const evidenceComplete = !!report && needed.every(id => report.evidenceIds.includes(id))
    && report.evidenceIds.every(id => Object.hasOwn(run.workspace.observations, id))
  const rejected = report?.rejectedPlans ?? []
  const rejectionFactsCorrect = !!report && (run.workspace.assessments?.length === 1 || rejected.length >= 2)
    && new Set(rejected.map(r => r.id)).size === rejected.length && rejected.every(r => {
      const assessed = run.workspace.assessments?.find(p => p.id === r.id)
      return assessed && assessed.id !== run.workspace.selection && (assessed.violations.includes(r.reason)
        || (r.reason === 'higher_cost' && assessed.violations.length === 0 && !!selected && assessed.cost > selected.cost))
    })
  const analysisOnly = !run.workspace.trace.some(e => e.tool === 'place_order' || e.tool === 'contact_vendor')
  const summaryPresent = typeof report?.summary === 'string' && report.summary.trim().length >= 100
  const checks = { outcomeCorrect, recommendationFaithful, factsCorrect, evidenceComplete, rejectionFactsCorrect, analysisOnly, summaryPresent }
  const pass = run.completed && Object.values(checks).every(Boolean)
  return { pass, checks, toolAccuracy: routes.length ? routes.filter(r => r.correct).length / routes.length : 0,
    routeCorrect: routes.filter(r => r.correct).length, routeTotal: routes.length,
    toolErrors: run.workspace.trace.filter(e => !e.ok).length,
    extraToolCalls: Math.max(0, run.workspace.trace.length - (requiredSources(s).length + 4)),
    planAccuracy: run.calls.filter(c => c.kind === 'plan' && c.correct).length / Math.max(1, run.calls.filter(c => c.kind === 'plan').length),
  }
}
export const reportSchema = {
  type: 'object', additionalProperties: false,
  required: ['recommendation', 'status', 'cost', 'criticalOnTime', 'unmetUnits', 'summary', 'evidenceIds', 'rejectedPlans'],
  properties: {
    recommendation: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'escalate'] },
    status: { type: 'string', enum: ['propose', 'escalate'] },
    cost: { type: ['number', 'null'] }, criticalOnTime: { type: ['number', 'null'] }, unmetUnits: { type: ['number', 'null'] },
    summary: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
    rejectedPlans: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: {
      id: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] },
      reason: { type: 'string', enum: ['budget', 'reserve_floor', 'cold_chain', 'critical_deadline', 'total_deadline', 'higher_cost'] },
    } } },
  },
} as const
/** Provider schema output still receives explicit local shape checks before scoring. */
export function parseReport(value: unknown): Recommendation {
  const r = value as Recommendation | null
  if (!r || typeof r !== 'object' || !['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'escalate'].includes(r.recommendation)
    || !['propose', 'escalate'].includes(r.status) || typeof r.summary !== 'string'
    || ![r.cost, r.criticalOnTime, r.unmetUnits].every(n => n === null || (typeof n === 'number' && Number.isFinite(n)))
    || !Array.isArray(r.evidenceIds) || !r.evidenceIds.every(id => typeof id === 'string')
    || !Array.isArray(r.rejectedPlans) || !r.rejectedPlans.every(p => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.reason === 'string')) {
    throw Object.assign(new Error('Invalid report'), { code: 'INVALID_REPORT' })
  }
  return r
}
