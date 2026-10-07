import type { AgentEvent, TurnBounds, TurnHooks, ToolDeclineReason, ExhaustedBudget } from '../types.ts'
import type { TraceRef } from '../../trace/trace.ts'
import type { RunTurnOptions } from './types.ts'
import type { modelRound } from './model-round.ts'
import { scheduleToolCalls } from '../schedule.ts'
import { dispatchQuota } from './dispatch-guards.ts'
import { runHook } from './hooks.ts'
import type { captureProgramGrants } from '../../tool/nested.ts'
import type { ProgramResultStore } from '../../tool/program-results.ts'
import type { prepareDispatch } from './dispatch-preparation.ts'

type SchedulerContext = {
  round: Awaited<ReturnType<typeof modelRound>>; options: RunTurnOptions; turn: number; step: number
  signal: AbortSignal; root: TraceRef; bounds: TurnBounds; guardDeclined: boolean | undefined
  budgetIsAWall: boolean; remaining: number; declineReason: ToolDeclineReason
  emit: (event: AgentEvent) => Promise<void>; recover: ReturnType<typeof prepareDispatch>['recover']
  toolActivity: (awaitsPerson: boolean, active: boolean) => void; finalizeUntil: number | undefined
  finalizeTools: Set<string>; finalizeReason: ExhaustedBudget | undefined; repeatedLimitBeforeDispatch: boolean
  individuallyRepeatedCallIds: Set<string>; programs: ReturnType<typeof captureProgramGrants> | undefined
  programResults: ProgramResultStore | undefined
}

function optionalDispatch<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

export async function dispatchRoundTools(ctx: SchedulerContext) {
  const { round, options, turn, step, signal, root, bounds, guardDeclined,
    budgetIsAWall, remaining, declineReason, emit, recover, toolActivity, finalizeUntil,
    finalizeTools, finalizeReason, repeatedLimitBeforeDispatch, individuallyRepeatedCallIds,
    programs, programResults } = ctx
  if (options.tools === undefined) throw new Error('tool dispatch requires a tool catalog')
  return scheduleToolCalls({
      calls: round.calls, catalog: options.tools, history: options.history,
      position: { turn, step,
        ...(options.accounting === undefined ? {} : { runId: options.accounting.runId }),
        ...(options.trace?.conversationId === undefined ? {} : { conversationId: options.trace.conversationId }),
      }, signal, parentTrace: root,
      maxParallel: bounds.maxParallel,
      dispatchLimit: dispatchQuota(guardDeclined === true, budgetIsAWall, remaining, round.calls.length),
      declineReason,
      maxResultBytes: bounds.maxToolResultBytes,
      maxResultTokens: bounds.maxToolResultTokens,
      resultOverflow: bounds.toolResultOverflow,
      ...optionalDispatch('spillStore', options.spillStore),
      maxDurationMs: bounds.maxToolDurationMs,
      teardownTimeoutMs: bounds.toolTeardownTimeoutMs,
      ...optionalDispatch('logger', options.logger),
      ...optionalDispatch('interceptors', options.interceptors),
      ...optionalDispatch('approvals', options.approvals),
      ...optionalDispatch('accounting', options.accounting),
      emit,
      ...optionalDispatch('recover', recover),
      ...options.hooks?.checkpoint === undefined ? {} : {
        checkpoint: (context: Parameters<NonNullable<TurnHooks['checkpoint']>>[0]) => runHook(
          Promise.resolve(options.hooks?.checkpoint?.(context)), options, signal, { name: 'checkpoint' },
        ),
      },
    }, {
      onToolActivity: toolActivity,
      admissionLimit: dispatchQuota(guardDeclined === true, budgetIsAWall, remaining, 'unbounded'),
      // In the finalize window even an always-reachable tool (asking a person,
      // messaging a teammate) would start work the spent budget cannot finish.
      ...finalizeUntil === undefined ? {} : {
        restrict: (call: typeof round.calls[number]): ToolDeclineReason | undefined =>
          finalizeTools.has(call.toolName) ? undefined : finalizeReason ?? 'steps',
      },
      ...guardDeclined || !repeatedLimitBeforeDispatch ? {} : {
        decline: (call: typeof round.calls[number]): ToolDeclineReason | undefined =>
          individuallyRepeatedCallIds.has(String(call.callId)) ? 'repeated-tool-call' : undefined,
      },
      ...optionalDispatch('programs', programs),
      ...optionalDispatch('programResults', programResults),
    })

}
