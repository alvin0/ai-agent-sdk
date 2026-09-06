import { createUserMessage } from '../../message/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import type { ModelCallReport } from '../../observation/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { authoritativeTokenUsage, budgetTokenTotal, summarizeModelCallUsage } from '../accounting/ledger.ts'
import { createSpanId, createTraceId, type TraceRef } from '../trace/trace.ts'
import type { AgentEvent, ExhaustedBudget, TurnHooks, TurnOutcome } from './types.ts'
import { AwaitedEventQueue } from './queue.ts'
import { runToolCalls } from './schedule.ts'
import { type RunTurnOptions } from './turn/types.ts'
import { resolveBounds, positiveFinite, snapshotRunTurnOptions } from './turn/config.ts'
import { codedRuntimeError, messageOf, errorCodeOf, now } from './turn/common.ts'
import { runOptionalHook, runHook } from './turn/hooks.ts'
import { maintenanceEmitter, emitAssistantContent, textOf } from './turn/content.ts'
import { repeatKey, toolActionPattern, repeatedSuffixCycle } from './turn/repetition.ts'
import { modelRound } from './turn/model-round.ts'

function hasCallableTools(options: RunTurnOptions): boolean {
  if (options.toolChoice === 'none') return false
  return (options.tools?.names().length ?? 0) > 0 || (options.nativeTools?.length ?? 0) > 0
}

/** Run one bounded turn as a backpressured event stream. */
export function runTurn(options: RunTurnOptions): AsyncIterable<AgentEvent> {
  return {
    async * [Symbol.asyncIterator]() {
      const invocation = snapshotRunTurnOptions(options)
      const queue = new AwaitedEventQueue<AgentEvent>()
      const consumer = new AbortController()
      const teardownTimeoutMs = positiveFinite(invocation.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
      const signal = invocation.signal === undefined
        ? consumer.signal
        : AbortSignal.any([invocation.signal, consumer.signal])
      const task = driveTurn(invocation, signal, event => queue.push(detachedFrozen(event)))
        .then(() => queue.close(), error => queue.fail(error))
      try {
        while (true) {
          const item = await queue.take()
          if (item.done) break
          yield item.value
        }
        await task
      } finally {
        consumer.abort(new Error('turn event consumer stopped'))
        queue.close()
        if (!await waitForSettlement(task, teardownTimeoutMs)) {
          throw codedRuntimeError(
            `turn producer ignored cancellation for more than ${teardownTimeoutMs}ms`,
            'TURN_TEARDOWN_TIMEOUT',
            consumer.signal.reason,
          )
        }
      }
    },
  }
}

async function driveTurn(
  options: RunTurnOptions,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  const bounds = resolveBounds(options.bounds)
  const traceId = options.trace?.traceId ?? createTraceId()
  const root: TraceRef = { traceId, spanId: createSpanId(), parentSpanId: options.trace?.parentSpanId ?? null }
  const turn = Math.max(1, options.history.entries().filter(entry =>
    entry.event.kind === 'user' && entry.event.message.source.kind === 'user').length)
  const startedAt = now()
  let steps = 0
  let toolCalls = 0
  let toolBudgetWarned = false
  let consecutiveErrors = 0
  let text = ''
  const modelCallReports: ModelCallReport[] = []
  let reason: TurnOutcome['reason'] | undefined
  let outcome: TurnOutcome
  const repeats = new Map<string, number>()
  const actionSteps: string[] = []
  const emitMaintenance = maintenanceEmitter(emit, root)
  let rootStarted = false
  let rootEnded = false
  const callableTools = hasCallableTools(options)
  const dedicatedFinalOutput = options.outputFormat?.type === 'json_schema' && callableTools
  const turnOperationId = options.accounting?.startOperation('turn', {
    data: { turn, model: options.config.model },
  })
  let turnOperationEnded = false
  let usageStop: TurnOutcome['reason'] | undefined
  // Shared by retries, hook continuations, and both finalizer paths. Finalizers
  // may have a separate step allowance, never a separate token allowance.
  const admissionStop = (): TurnOutcome['reason'] | undefined => {
    if (signal.aborted) return { kind: 'aborted' }
    if (usageStop !== undefined) return usageStop
    const tokens = budgetTokenTotal(summarizeModelCallUsage(modelCallReports))
    return tokens !== undefined && tokens >= bounds.maxTotalTokens
      ? { kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: false }
      : undefined
  }

  try {
  await emit({
    type: 'span-start', trace: root, at: startedAt,
    name: `invoke_agent ${options.trace?.agentId ?? 'agent'}`, kind: 'invoke_agent',
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': options.trace?.agentId ?? 'agent',
      'gen_ai.agent.name': options.trace?.agentName ?? options.trace?.agentId ?? 'agent',
      'gen_ai.request.model': options.config.model,
      ...options.trace?.conversationId === undefined
        ? {}
        : { 'gen_ai.conversation.id': options.trace.conversationId },
    },
  })
  rootStarted = true
  await emit({ type: 'turn-start', turn, trace: root })

  turnLifecycle: while (true) {
  while (reason === undefined && steps < bounds.maxSteps && !signal.aborted) {
    reason = admissionStop()
    if (reason !== undefined) break
    const step = steps + 1
    const round = await modelRound(
      options, signal, emit, emitMaintenance, root, turn, step,
      dedicatedFinalOutput
        ? 'process'
        : options.outputFormat?.type === 'json_schema' ? 'final' : 'standard',
    )
    steps++
    if (round.report !== undefined) modelCallReports.push(round.report)
    if (round.message !== undefined) {
      options.history.append({
        kind: 'assistant', message: round.message,
        ...round.finish.kind === 'aborted' ? { interrupted: true as const } : {},
        ...round.usage === undefined ? {} : { usage: round.usage },
      })
      await emit({ type: 'assistant-message', message: round.message, trace: round.trace })
      await emitAssistantContent(round, emit)
      text = textOf(round.message.content)
    }
    usageStop = round.usageRequired
      ? { kind: 'error', failure: { message: 'provider usage is required by the configured run policy', code: 'USAGE_REQUIRED' } }
      : round.usageUnavailable
        ? { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
        : undefined
    if (signal.aborted || round.finish.kind === 'aborted') { reason = { kind: 'aborted' }; break }
    // Pair emitted tool calls with declined results even when policy stops the
    // run; never execute those calls or allow a retry hook to override policy.
    if (round.finish.kind === 'error' && usageStop !== undefined) {
      reason = { kind: 'error', failure: round.finish.failure }
      break
    }
    if (round.usageRequired && (round.calls.length === 0 || options.tools === undefined)) { reason = usageStop; break }
    if (round.finish.kind === 'error' && !round.usageRequired) {
      reason = admissionStop()
      if (reason !== undefined) break
      const decision = await runOptionalHook(options.hooks?.onRequestError, [{
        turn, step, failure: round.finish.failure, snapshot: options.history.snapshot(), signal,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        emit: emitMaintenance,
      }], options, signal, 'onRequestError')
      if (decision === 'retry' && steps < bounds.maxSteps) continue
      reason = { kind: 'error', failure: round.finish.failure }
      break
    }
    if (round.finish.kind === 'max-tokens' && !round.usageRequired) { reason = { kind: 'max-tokens' }; break }
    if (round.calls.length === 0 && round.usageUnavailable) {
      reason = { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
      break
    }
    if (round.calls.length === 0 && dedicatedFinalOutput) {
      reason = admissionStop()
      if (reason !== undefined) break
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'structured-output-finalizer' },
        content: [{
          type: 'text',
          text: 'The process phase is complete. Return the final answer now in the requested output format. Do not call tools.',
        }],
      }) })
      const final = await modelRound(
        options, signal, emit, emitMaintenance, root, turn, steps + 1, 'final',
      )
      steps++
      if (final.report !== undefined) modelCallReports.push(final.report)
      if (final.message !== undefined) {
        options.history.append({
          kind: 'assistant', message: final.message,
          ...final.usage === undefined ? {} : { usage: final.usage },
        })
        await emit({ type: 'assistant-message', message: final.message, trace: final.trace })
        await emitAssistantContent(final, emit)
        text = textOf(final.message.content)
      }
      if (final.finish.kind === 'aborted') reason = { kind: 'aborted' }
      else if (final.finish.kind === 'error') reason = { kind: 'error', failure: final.finish.failure }
      else if (final.finish.kind === 'max-tokens') reason = { kind: 'max-tokens' }
      else if (final.usageRequired) reason = { kind: 'error', failure: {
        message: 'provider usage is required by the configured run policy',
        code: 'USAGE_REQUIRED',
      } }
      else if (final.usageUnavailable) {
        reason = { kind: 'usage-unavailable', modelCallId: final.report?.modelCallId ?? 'unknown' }
      } else reason = { kind: 'completed' }
      break
    }
    if (round.calls.length === 0 || options.tools === undefined) { reason = { kind: 'completed' }; break }

    const remaining = Math.max(0, bounds.maxToolCalls - toolCalls)
    const repeatProjection = new Map(repeats)
    const projectedRepeats = round.calls.map(call => {
      const key = repeatKey(call)
      const count = (repeatProjection.get(key) ?? 0) + 1
      repeatProjection.set(key, count)
      return count
    })
    const repeatedLimitBeforeDispatch = projectedRepeats.some(count => count >= bounds.repeatToolLimit)
    const actionPattern = toolActionPattern(round.calls)
    const projectedCycle = repeatedSuffixCycle(
      [...actionSteps, actionPattern],
      bounds.maxToolCycleLength,
    )
    const cycleLimitBeforeDispatch = projectedCycle !== undefined
      && projectedCycle.repetitions >= bounds.toolCycleLimit
    const currentUsage = summarizeModelCallUsage(modelCallReports)
    const budgetTokens = budgetTokenTotal(currentUsage)
    const tokenLimitBeforeDispatch = budgetTokens !== undefined
      && budgetTokens >= bounds.maxTotalTokens
    const guardDeclined = repeatedLimitBeforeDispatch || cycleLimitBeforeDispatch || tokenLimitBeforeDispatch || round.usageRequired
    const scheduled = await runToolCalls({
      calls: round.calls, catalog: options.tools, history: options.history,
      position: { turn, step }, signal, parentTrace: root,
      maxParallel: bounds.maxParallel, dispatchLimit: guardDeclined ? 0 : remaining,
      maxResultBytes: bounds.maxToolResultBytes,
      maxDurationMs: bounds.maxToolDurationMs,
      teardownTimeoutMs: bounds.toolTeardownTimeoutMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
      ...options.approvals === undefined ? {} : { approvals: options.approvals },
      ...options.accounting === undefined ? {} : { accounting: options.accounting },
      emit,
      ...options.hooks?.checkpoint === undefined ? {} : {
        checkpoint: (context: Parameters<NonNullable<TurnHooks['checkpoint']>>[0]) => runHook(
          Promise.resolve(options.hooks?.checkpoint?.(context)), options, signal, 'checkpoint',
        ),
      },
    })
    toolCalls += scheduled.dispatched
    const remainingAfterDispatch = Math.max(0, bounds.maxToolCalls - toolCalls)
    const warningAt = Math.max(1, Math.floor(bounds.maxToolCalls * 0.25))
    if (!toolBudgetWarned && remainingAfterDispatch > 0 && remainingAfterDispatch <= warningAt) {
      toolBudgetWarned = true
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-budget-guard' },
        content: [{
          type: 'text',
          text: `Tool budget warning: ${remainingAfterDispatch} of ${bounds.maxToolCalls} calls remain. Stop broad exploration, make the necessary edits, and reserve calls for verification.`,
        }],
      }) })
    }
    await emit({ type: 'step-end', turn, step, trace: round.trace })

    actionSteps.push(actionPattern)
    let repeatedLimit = repeatedLimitBeforeDispatch
    for (let index = 0; index < round.calls.length; index++) {
      const call = round.calls[index]
      const result = scheduled.results[index]
      if (call === undefined || result === undefined) continue
      consecutiveErrors = result.isError ? consecutiveErrors + 1 : 0
      const key = repeatKey(call)
      const count = (repeats.get(key) ?? 0) + 1
      repeats.set(key, count)
      if (count === bounds.repeatToolWarningAt) {
        options.history.append({ kind: 'user', message: createUserMessage({
          source: { kind: 'app', producer: 'tool-loop-repeat-guard' },
          content: [{ type: 'text', text: `You have called ${call.toolName} with the same arguments ${count} times. Reassess before repeating it.` }],
        }) })
      }
      if (count >= bounds.repeatToolLimit) repeatedLimit = true
    }
    if (projectedCycle?.repetitions === bounds.toolCycleWarningAt) {
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-cycle-guard' },
        content: [{
          type: 'text',
          text: `Tool-use pattern repeated ${projectedCycle.repetitions} times across ${projectedCycle.period} step(s). Reassess the approach and identify concrete new evidence before continuing.`,
        }],
      }) })
    }
    if (scheduled.concluded) { reason = { kind: 'concluded-by-tool', toolName: scheduled.concludedBy ?? 'unknown' }; break }
    if (signal.aborted) { reason = { kind: 'aborted' }; break }
    if (round.usageRequired) { reason = usageStop; break }
    if (round.usageUnavailable) {
      reason = { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
      break
    }
    let exhausted: ExhaustedBudget | undefined
    if (tokenLimitBeforeDispatch) exhausted = 'tokens'
    else if (cycleLimitBeforeDispatch) exhausted = 'tool-call-cycle'
    else if (round.calls.length > remaining) exhausted = 'tool-calls'
    else if (consecutiveErrors >= bounds.maxConsecutiveToolErrors) exhausted = 'consecutive-tool-errors'
    else if (repeatedLimit) exhausted = 'repeated-tool-call'
    else if (steps >= bounds.maxSteps) exhausted = 'steps'
    if (exhausted !== undefined) {
      const forced = exhausted !== 'tokens'
        && bounds.onExhausted === 'force-final-answer'
        && admissionStop() === undefined
      if (forced) {
        const final = await modelRound(
          options, signal, emit, emitMaintenance, root, turn, steps + 1, 'forced-final',
        )
        steps++
        if (final.report !== undefined) modelCallReports.push(final.report)
        if (final.message !== undefined) {
          options.history.append({ kind: 'assistant', message: final.message, ...final.usage === undefined ? {} : { usage: final.usage } })
          await emit({ type: 'assistant-message', message: final.message, trace: final.trace })
          await emitAssistantContent(final, emit)
          text = textOf(final.message.content)
        }
        if (final.finish.kind === 'aborted') {
          reason = { kind: 'aborted' }
          break
        }
        if (final.finish.kind === 'error') {
          reason = { kind: 'error', failure: final.finish.failure }
          break
        }
        if (final.finish.kind === 'max-tokens') {
          reason = { kind: 'max-tokens' }
          break
        }
        if (final.usageRequired) {
          reason = { kind: 'error', failure: {
            message: 'provider usage is required by the configured run policy',
            code: 'USAGE_REQUIRED',
          } }
          break
        }
        if (final.usageUnavailable) {
          reason = { kind: 'usage-unavailable', modelCallId: final.report?.modelCallId ?? 'unknown' }
          break
        }
      }
      reason = { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: forced }
    }
  }

  if (reason === undefined) {
    reason = signal.aborted
      ? { kind: 'aborted' }
      : { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: false }
  }
  const usageReport = summarizeModelCallUsage(modelCallReports)
  const usage = authoritativeTokenUsage(usageReport)
  const candidate: TurnOutcome = {
    reason, text, steps, usageReport, toolCalls, traceId,
    ...usage === undefined ? {} : { usage },
  }
  const entriesBeforeHook = options.history.entries().length
  const canContinue = reason.kind === 'completed'
    && steps < bounds.maxSteps
    && admissionStop() === undefined
  await runOptionalHook(options.hooks?.onTurnEnd, [{
    outcome: candidate,
    snapshot: options.history.snapshot(),
    canContinue,
  }], options, signal, 'onTurnEnd')
  // Hooks object by appending context rather than by returning a veto. Re-run only
  // a normally completed turn; abort/error/budget outcomes remain terminal.
  if (canContinue
    && options.history.entries().length > entriesBeforeHook
    && !signal.aborted) {
    reason = undefined
    continue turnLifecycle
  }
  outcome = candidate
  break
  }
  await emit({
    type: 'span-end', trace: root, at: now(),
    status: outcome.reason.kind === 'error' ? 'error' : outcome.reason.kind === 'aborted' ? 'aborted' : 'success',
    output: { reason: outcome.reason, text },
    ...outcome.usage === undefined ? {} : { usage: outcome.usage },
    ...outcome.reason.kind === 'error' ? { error: { type: 'ModelError', message: outcome.reason.failure.message, code: outcome.reason.failure.code } } : {},
  })
  rootEnded = true
  if (turnOperationId !== undefined) {
    options.accounting?.endOperation(
      turnOperationId,
      outcome.reason.kind === 'error' ? 'error' : outcome.reason.kind === 'aborted' ? 'aborted' : 'success',
      { data: { reason: outcome.reason.kind, steps, toolCalls } },
    )
    turnOperationEnded = true
  }
  await emit({ type: 'turn-end', outcome, trace: root })
  } catch (error: unknown) {
    const code = errorCodeOf(error)
    if (rootStarted && !rootEnded) {
      await emit({
        type: 'span-end', trace: root, at: now(), status: signal.aborted ? 'aborted' : 'error',
        error: {
          type: error instanceof Error ? error.name : 'RuntimeError',
          message: messageOf(error),
          ...code === undefined ? {} : { code },
        },
      }).catch(() => undefined)
    }
    if (turnOperationId !== undefined && !turnOperationEnded) {
      options.accounting?.endOperation(
        turnOperationId,
        signal.aborted ? 'aborted' : 'error',
        { error },
      )
      turnOperationEnded = true
    }
    throw error
  }
}


export type { RunTurnOptions } from './turn/types.ts'
