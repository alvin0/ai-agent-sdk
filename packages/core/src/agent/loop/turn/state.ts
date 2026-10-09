import { type Message } from '../../../message/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import { budgetTokenTotal, summarizeModelCallUsage } from '../../accounting/ledger.ts'
import { createSpanId, createTraceId, type TraceRef } from '../../trace/trace.ts'
import type { ToolDefinition, ToolExecutionResult } from '../../tool/definition.ts'
import type { AgentEvent, ExhaustedBudget, TurnOutcome } from '../types.ts'
import { captureProgramGrants } from '../../tool/nested.ts'
import { ProgramResultStore } from '../../tool/program-results.ts'
import { type RunTurnOptions } from './types.ts'
import { resolveBounds } from './config.ts'
import { now } from './common.ts'
import { maintenanceEmitter } from './content.ts'
import { accountingUsageStop } from './usage-stop.ts'
import type { ContextToolTouch } from '../../context/types.ts'
import { createBudgetNoticeAppender, createTurnContextSections } from './context.ts'
import { createTurnClock } from './work-clock.ts'
import { type FinalRoundContext } from './final-round.ts'

function budgetState(options: RunTurnOptions) {
  const bounds = resolveBounds(options.bounds)
  return {
    bounds,
    maxTotalTokens: bounds.maxTotalTokens === 'auto' ? Infinity : bounds.maxTotalTokens,
    maxSteps: bounds.maxSteps === 'auto' ? Infinity : bounds.maxSteps,
    maxTurnDurationMs: bounds.maxTurnDurationMs === 'auto' ? Infinity : bounds.maxTurnDurationMs,
    budgetReminders: [...bounds.toolBudgetRemindAt]
      .filter(threshold => threshold > 0 && threshold < bounds.maxToolCalls)
      .sort((left, right) => right - left),
    budgetRemindersSent: 0, overBudgetNoticesSent: 0, stepReminderSent: false, tokenRemindersSent: 0,
    finalizeUntil: undefined as number | undefined,
    finalizeReason: undefined as ExhaustedBudget | undefined,
    finalizeOrigin: undefined as Extract<TurnOutcome['reason'],
      { kind: 'budget-exhausted' } | { kind: 'completed' }> | undefined,
    forcedText: '', forcedMessage: undefined as Message | undefined,
    finalizePromptSeq: undefined as number | undefined,
    finalizeTools: new Set(options.finalize?.tools ?? []),
  }
}

function hasCallableTools(options: RunTurnOptions): boolean {
  if (options.toolChoice === 'none') return false
  return (options.tools?.names().length ?? 0) > 0 || (options.nativeTools?.length ?? 0) > 0
}

function toolState(options: RunTurnOptions) {
  const callableTools = hasCallableTools(options)
  const programs = options.experimentalPrograms === undefined
    ? undefined : captureProgramGrants(options.experimentalPrograms)
  return {
    toolCalls: 0, consecutiveErrors: 0, actionSteps: [] as string[],
    lastRepeat: undefined as { key: string; count: number; callId: string; succeeded: boolean } | undefined,
    successfulCalls: new Map<string, {
      readonly callId: string
      readonly rawArguments: string
      readonly definition: ToolDefinition | undefined
      readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
    }>(),
    recoveredReplanKeys: new Set<string>(),
    callableTools, programs, programResults: programs === undefined ? undefined : new ProgramResultStore(),
    dedicatedFinalOutput: options.outputFormat?.type === 'json_schema' && callableTools,
  }
}

function baseState(options: RunTurnOptions, signal: AbortSignal, emit: (event: AgentEvent) => Promise<void>) {
  const budgets = budgetState(options)
  const traceId = options.trace?.traceId ?? createTraceId()
  const root: TraceRef = { traceId, spanId: createSpanId(), parentSpanId: options.trace?.parentSpanId ?? null }
  const turn = Math.max(1, options.history.entries().filter(entry =>
    entry.event.kind === 'user' && entry.event.message.source.kind === 'user').length)
  const startedAt = now()
  const clock = createTurnClock()
  const contextSections = createTurnContextSections(options, signal)
  return {
    ...budgets, ...toolState(options), ...clock, options, signal, emit, root, traceId, turn,
    startedAt, steps: 0, retriedRounds: 0, consecutiveFailures: 0, grantedRetries: 0, text: '',
    modelCallReports: [] as ModelCallReport[],
    reason: undefined as TurnOutcome['reason'] | undefined,
    usageStop: undefined as TurnOutcome['reason'] | undefined,
    contextTouches: [] as ContextToolTouch[], contextSections,
    appendBudgetNotice: createBudgetNoticeAppender(options), emitMaintenance: maintenanceEmitter(emit, root),
    rootStarted: false, rootEnded: false, turnOperationEnded: false,
    turnOperationId: options.accounting?.startOperation('turn', { data: { turn, model: options.config.model } }),
  }
}

type BaseState = ReturnType<typeof baseState>

function admissionStop(state: BaseState, pendingReport?: ModelCallReport): TurnOutcome['reason'] | undefined {
  if (state.signal.aborted) return { kind: 'aborted' }
  const mandatoryStop = accountingUsageStop(state.options.accounting)
  if (mandatoryStop !== undefined) return mandatoryStop
  if (state.usageStop !== undefined) return state.usageStop
  const reports = pendingReport === undefined ? state.modelCallReports : [...state.modelCallReports, pendingReport]
  const tokens = budgetTokenTotal(summarizeModelCallUsage(reports))
  return tokens !== undefined && tokens >= state.maxTotalTokens
    ? { kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: false }
    : undefined
}

export function createTurnState(
  options: RunTurnOptions, signal: AbortSignal, emit: (event: AgentEvent) => Promise<void>,
) {
  const state = baseState(options, signal, emit)
  const workSteps = (): number => state.steps - state.retriedRounds
  const position = () => ({ workStep: workSteps() + 1, finalizing: state.finalizeUntil !== undefined })
  const stop = (pendingReport?: ModelCallReport) => admissionStop(state, pendingReport)
  const finalContext: FinalRoundContext = {
    options, signal, emit, emitMaintenance: state.emitMaintenance, root: state.root,
    turn: state.turn, modelCallReports: state.modelCallReports,
    get steps() { return state.steps }, set steps(value: number) { state.steps = value },
    get retriedRounds() { return state.retriedRounds },
    set retriedRounds(value: number) { state.retriedRounds = value },
    get text() { return state.text }, set text(value: string) { state.text = value },
    get consecutiveFailures() { return state.consecutiveFailures },
    set consecutiveFailures(value: number) { state.consecutiveFailures = value },
    get grantedRetries() { return state.grantedRetries },
    set grantedRetries(value: number) { state.grantedRetries = value },
    position, admissionStop: stop,
  }
  return Object.assign(state, { workSteps, position, admissionStop: stop, finalContext })
}

export type TurnState = ReturnType<typeof createTurnState>
