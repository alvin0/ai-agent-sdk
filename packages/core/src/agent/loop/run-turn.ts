import { createMessage, createUserMessage, type Message } from '../../message/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import type { ModelCallReport } from '../../observation/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { authoritativeTokenUsage, budgetTokenTotal, summarizeModelCallUsage } from '../accounting/ledger.ts'
import { createSpanId, createTraceId, type TraceRef } from '../trace/trace.ts'
import type { ToolDefinition, ToolExecutionResult } from '../tool/definition.ts'
import type { AgentEvent, ExhaustedBudget, ToolDeclineReason, TurnHooks, TurnOutcome } from './types.ts'
import { AwaitedEventQueue } from './queue.ts'
import { scheduleToolCalls } from './schedule.ts'
import { captureProgramGrants } from '../tool/nested.ts'
import { ProgramResultStore } from '../tool/program-results.ts'
import { type RunTurnOptions } from './turn/types.ts'
import { resolveBounds, positiveFinite, snapshotRunTurnOptions } from './turn/config.ts'
import { codedRuntimeError, messageOf, errorCodeOf, now } from './turn/common.ts'
import { deliverQueuedInput, hasQueuedInput } from './turn/model-request-boundary.ts'
import { runOptionalHook, runHook } from './turn/hooks.ts'
import { maintenanceEmitter, emitAssistantContent, textOf } from './turn/content.ts'
import { repeatKey, toolActionPattern, repeatedSuffixCycle } from './turn/repetition.ts'
import { modelRound } from './turn/model-round.ts'
import { accountingUsageStop } from './turn/usage-stop.ts'
import { ContextSectionRuntime } from '../context/section.ts'
import type { ContextToolTouch } from '../context/types.ts'

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

/** Request retries per turn that do not count against `maxSteps`. */
const MAX_FREE_REQUEST_RETRIES = 8

async function driveTurn(
  options: RunTurnOptions,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  const bounds = resolveBounds(options.bounds)
  const maxTotalTokens = bounds.maxTotalTokens === 'auto' ? Infinity : bounds.maxTotalTokens
  // Infinity is local control flow only. Public configuration/events retain
  // the serializable 'auto' value, and all other admission guards still apply.
  const maxSteps = bounds.maxSteps === 'auto' ? Infinity : bounds.maxSteps
  const traceId = options.trace?.traceId ?? createTraceId()
  const root: TraceRef = { traceId, spanId: createSpanId(), parentSpanId: options.trace?.parentSpanId ?? null }
  const turn = Math.max(1, options.history.entries().filter(entry =>
    entry.event.kind === 'user' && entry.event.message.source.kind === 'user').length)
  const startedAt = now()
  let steps = 0
  /**
   * Rounds the request-error hook asked to retry. Each still gets its own step
   * number, but a provider blip must not spend the work the budget is for:
   * limits compare `workSteps`. Bounded, so a hook that always retries cannot
   * loop forever; past the bound a retry costs a step as it used to.
   */
  let retriedRounds = 0
  const workSteps = (): number => steps - retriedRounds
  const position = () => ({ workStep: workSteps() + 1, finalizing: finalizeUntil !== undefined })
  // Wall-clock budget for the turn's own work. Time spent waiting for a person
  // is not work, so it is not charged.
  const maxTurnDurationMs = bounds.maxTurnDurationMs === 'auto' ? Infinity : bounds.maxTurnDurationMs
  const turnStartedMs = Date.now()
  let personWaitMs = 0
  let waitingSince: number | undefined
  let personCalls = 0
  let workCalls = 0
  const toolActivity = (awaitsPerson: boolean, active: boolean): void => {
    const at = Date.now()
    if (waitingSince !== undefined) personWaitMs += at - waitingSince
    if (awaitsPerson) personCalls += active ? 1 : -1
    else workCalls += active ? 1 : -1
    // Only time spent solely waiting is free; parallel tool work still counts.
    waitingSince = personCalls > 0 && workCalls === 0 ? at : undefined
  }
  const timeSpent = (): number => {
    const at = Date.now()
    return at - turnStartedMs - personWaitMs - (waitingSince === undefined ? 0 : at - waitingSince)
  }
  /**
   * A spent budget ends the turn with an answer, not without one: one
   * tools-off round writes it from the evidence already gathered. That round
   * gets the request-error retry, and one more try if it came back empty,
   * because it is the only thing the person will receive.
   */
  const forceAnswer = async (
    exhausted: ExhaustedBudget,
    reserveTrigger: boolean,
  ): Promise<TurnOutcome['reason']> => {
    let final = await retryFinalRound(await modelRound(
      options, signal, emit, emitMaintenance, root, turn, steps + 1, 'forced-final', position(),
    ), 'forced-final')
    // No answer came back: empty text, or only a call to a tool it cannot use.
    const unanswered = (round: typeof final) => !round.usageRequired && !round.usageUnavailable
      && ((round.finish.kind === 'stop' && textOf(round.message?.content ?? []).trim() === '')
        || (round.finish.kind === 'error' && round.finish.failure.code === 'INVALID_TOOL_CALL'))
    if (unanswered(final) && !signal.aborted && retriedRounds < MAX_FREE_REQUEST_RETRIES
      && admissionStop() === undefined) {
      if (final.report !== undefined) modelCallReports.push(final.report)
      if (final.message !== undefined) {
        options.history.append({ kind: 'assistant', message: final.message, ...final.usage === undefined ? {} : { usage: final.usage } })
      }
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'forced-answer-empty' },
        content: [{ type: 'text', text: 'Your last reply contained no answer. Tools are disabled now. Write the answer for the user now, in text, from the evidence already gathered, and state what could not be checked.' }],
      }) })
      steps++
      retriedRounds++
      final = await modelRound(options, signal, emit, emitMaintenance, root, turn, steps + 1, 'forced-final', position())
    }
    steps++
    if (final.report !== undefined) modelCallReports.push(final.report)
    if (final.message !== undefined) {
      options.history.append({ kind: 'assistant', message: final.message, ...final.usage === undefined ? {} : { usage: final.usage } })
      await emit({ type: 'assistant-message', message: final.message, trace: final.trace })
      await emitAssistantContent(final, emit)
      text = textOf(final.message.content)
    } else {
      // The forced answer said nothing; an earlier round's narration is not it.
      text = ''
    }
    if (final.finish.kind === 'aborted') return { kind: 'aborted' }
    // A model that still only reaches for tools has given no answer; that is
    // the budget's stop without one, not a failure of the run.
    if (final.finish.kind === 'error' && final.finish.failure.code === 'INVALID_TOOL_CALL') {
      text = ''
      return { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: false,
        ...(reserveTrigger ? { trigger: 'report-reserve' as const } : {}) }
    }
    if (final.finish.kind === 'error') return { kind: 'error', failure: final.finish.failure }
    if (final.finish.kind === 'max-tokens') return { kind: 'max-tokens' }
    if (final.usageRequired) {
      return { kind: 'error', failure: { message: 'provider usage is required by the configured run policy', code: 'USAGE_REQUIRED' } }
    }
    if (final.usageUnavailable) {
      return accountingUsageStop(options.accounting) ?? { kind: 'usage-unavailable', modelCallId: final.report?.modelCallId ?? 'unknown' }
    }
    return { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: true,
      ...(reserveTrigger ? { trigger: 'report-reserve' as const } : {}) }
  }
  /**
   * The tools-off rounds that close a turn (the forced answer, the structured
   * output finalizer) are the single call the whole run's evidence depends on.
   * A transient failure there gets the same retry hook as any other request,
   * from the same free-retry allowance; the failed attempt is not kept.
   */
  const retryFinalRound = async (
    first: Awaited<ReturnType<typeof modelRound>>,
    phase: 'final' | 'forced-final',
  ): Promise<Awaited<ReturnType<typeof modelRound>>> => {
    let final = first
    while (final.finish.kind === 'error' && !final.usageRequired && !signal.aborted
      && retriedRounds < MAX_FREE_REQUEST_RETRIES && admissionStop() === undefined) {
      const decision = await runOptionalHook(options.hooks?.onRequestError, [{
        turn, step: steps + 1, failure: final.finish.failure, snapshot: options.history.snapshot(), signal,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        emit: emitMaintenance,
      }], options, signal, 'onRequestError')
        // A hook waiting out a backoff when the person aborts throws the abort;
        // that is a cancelled turn, not a crashed one.
        .catch((error: unknown) => { if (signal.aborted) return 'fail' as const; throw error })
      if (decision !== 'retry' || signal.aborted || accountingUsageStop(options.accounting) !== undefined) break
      if (final.report !== undefined) modelCallReports.push(final.report)
      // The failed attempt keeps its step number; the caller counts the last one.
      steps++
      retriedRounds++
      final = await modelRound(options, signal, emit, emitMaintenance, root, turn, steps + 1, phase, position())
    }
    return final
  }
  let toolCalls = 0
  // Descending, so "how many are below the remainder" counts the crossings.
  const budgetReminders = [...bounds.toolBudgetRemindAt]
    .filter(threshold => threshold > 0 && threshold < bounds.maxToolCalls)
    .sort((left, right) => right - left)
  let budgetRemindersSent = 0
  /** How many full budgets an unwalled turn has spent and been told about. */
  let overBudgetNoticesSent = 0
  /** Sequence of the budget notice currently on the surface, if any. */
  let budgetNoticeSeq: number | undefined
  let stepReminderSent = false
  /**
   * After a budget forced the answer, at most one short window in which only
   * budget-exempt tools run; see `TurnBounds.finalizeSteps`.
   */
  let finalizeUntil: number | undefined
  let finalizeReason: ExhaustedBudget | undefined
  /** The forced-answer outcome that opened the window; the turn still ends as it. */
  let finalizeOrigin: Extract<TurnOutcome['reason'], { kind: 'budget-exhausted' } | { kind: 'completed' }> | undefined
  let forcedText = ''
  let forcedMessage: Message | undefined
  const finalizeTools = new Set(options.finalize?.tools ?? [])
  let tokenRemindersSent = 0
  let consecutiveErrors = 0
  let text = ''
  const modelCallReports: ModelCallReport[] = []
  let reason: TurnOutcome['reason'] | undefined
  let outcome: TurnOutcome
  /** The immediately preceding call/result, so recovery cannot cross a state-changing call or failure. */
  let lastRepeat: { key: string; count: number; callId: string; succeeded: boolean } | undefined
  /** Successful finalized results, retained only for this turn's exact repeat guard. */
  const successfulCalls = new Map<string, {
    readonly callId: string
    readonly rawArguments: string
    readonly definition: ToolDefinition | undefined
    readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
  }>()
  /** Each exact recovered key gets one ordinary model replan, never a retry loop. */
  const recoveredReplanKeys = new Set<string>()
  const actionSteps: string[] = []
  const emitMaintenance = maintenanceEmitter(emit, root)
  /**
   * Put the current budget notice on the surface, replacing the previous one.
   *
   * One live notice, never a pile of them. Appending each new remainder leaves
   * "16 calls remain" and "6 calls remain" both readable, and a model that
   * plans against the older number plans against a budget it no longer has.
   * Codex keeps exactly one `<rollout_budget>` fragment for the same reason
   * (`context/rollout_budget.rs`), replacing it as the number moves.
   * @param text - What the model should read now.
   */
  const appendBudgetNotice = (text: string): void => {
    const message = createUserMessage({
      source: { kind: 'app', producer: 'tool-loop-budget-guard' },
      content: [{ type: 'text', text }],
    })
    const previous = budgetNoticeSeq
    // Replacing is best-effort. Compaction can shadow the earlier notice
    // between steps, and a replace whose target is no longer on the surface is
    // rejected — which must cost the model a reminder, never the turn.
    if (previous !== undefined) {
      try {
        budgetNoticeSeq = options.history.append(
          { kind: 'user', message },
          { op: 'replace', from: previous, to: previous, targets: [previous] },
        ).seq
        return
      } catch {
        budgetNoticeSeq = undefined
      }
    }
    budgetNoticeSeq = options.history.append({ kind: 'user', message }).seq
  }
  const contextSections = options.contextSections === undefined || options.contextSections.length === 0
    ? undefined
    : new ContextSectionRuntime({
      sections: options.contextSections,
      history: options.history,
      ...options.logger === undefined ? {} : { logger: options.logger },
      guard: (pending, name) => runHook(pending, options, signal, name),
      scope: { agentId: options.trace?.agentId, conversationId: options.trace?.conversationId },
    })
  /** Tool calls committed since the last section reconcile. */
  let contextTouches: ContextToolTouch[] = []
  let rootStarted = false
  let rootEnded = false
  const callableTools = hasCallableTools(options)
  const programs = options.experimentalPrograms === undefined ? undefined : captureProgramGrants(options.experimentalPrograms)
  // Handles programs retain live for this turn only.
  const programResults = programs === undefined ? undefined : new ProgramResultStore()
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
    const mandatoryStop = accountingUsageStop(options.accounting)
    if (mandatoryStop !== undefined) return mandatoryStop
    if (usageStop !== undefined) return usageStop
    const tokens = budgetTokenTotal(summarizeModelCallUsage(modelCallReports))
    return tokens !== undefined && tokens >= maxTotalTokens
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
  while (reason === undefined && workSteps() < (finalizeUntil ?? maxSteps) && !signal.aborted) {
    reason = admissionStop()
    if (reason !== undefined) break
    // Out of time before another work round: answer now, from what is known.
    if (steps > 0 && finalizeUntil === undefined && timeSpent() >= maxTurnDurationMs) {
      reason = bounds.onExhausted === 'stop'
        ? { kind: 'budget-exhausted', budget: 'time', forcedFinalAnswer: false }
        : await forceAnswer('time', false)
      break
    }
    // Auto has no step countdown. Warn from the same usage total as admission,
    // before a hard token stop can leave the agent without a reporting call.
    const usedTokens = budgetTokenTotal(summarizeModelCallUsage(modelCallReports))
    if (bounds.maxTotalTokens !== 'auto' && usedTokens !== undefined) {
      const crossed = [0.5, 0.75, 0.9].filter(ratio => usedTokens >= maxTotalTokens * ratio).length
      if (crossed > tokenRemindersSent) {
        tokenRemindersSent = crossed
        const remaining = Math.max(0, maxTotalTokens - usedTokens)
        options.history.append({ kind: 'user', message: createUserMessage({
          source: { kind: 'app', producer: 'tool-loop-token-guard' },
          content: [{ type: 'text', text: `Token budget: ${remaining} of ${bounds.maxTotalTokens} aggregate tokens remain. Each request also spends input tokens on the accumulated context. `
            + (crossed >= 2 ? 'Stop broad exploration. ' : 'Prioritize outstanding verification and reporting. ')
            + 'Reserve capacity for the required self-check, honest todo reconciliation and substantive final report. State unavailable evidence and unfinished work; do not claim it is verified. No extra model call is allowed after the hard token limit.',
          }],
        }) })
      }
    }
    // Leave time to reconcile a plan and submit a result before the final
    // tools-disabled summary. Tool-call reminders do not cover step limits.
    if (!stepReminderSent && finalizeUntil === undefined && workSteps() > 0 && maxSteps - workSteps() <= 2) {
      stepReminderSent = true
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-step-guard' },
        content: [{ type: 'text', text:
          `${maxSteps - workSteps()} work steps remain. Finish essential verification, update any task list honestly, and submit the result if required. Summarize findings, evidence, and unfinished work; do not start new exploration.`,
        }],
      }) })
    }
    // Recomputed before the request that will read it, so a section reacting to
    // the previous step's tool calls is already on the surface.
    if (contextSections !== undefined) {
      await contextSections.reconcile(steps, contextTouches, signal)
      contextTouches = []
    }
    const step = steps + 1
    const round = await modelRound(
      options, signal, emit, emitMaintenance, root, turn, step,
      dedicatedFinalOutput
        ? 'process'
        : options.outputFormat?.type === 'json_schema' ? 'final' : 'standard',
      position(),
    )
    steps++
    if (round.report !== undefined) modelCallReports.push(round.report)
    usageStop = accountingUsageStop(options.accounting) ?? (round.usageRequired
      ? { kind: 'error', failure: { message: 'provider usage is required by the configured run policy', code: 'USAGE_REQUIRED' } }
      : round.usageUnavailable
        ? { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
        : undefined)
    const commitRound = async (): Promise<void> => {
      if (round.message !== undefined) {
        options.history.append({
          kind: 'assistant', message: round.message,
          ...round.finish.kind === 'aborted' ? { interrupted: true as const } : {},
          ...round.usage === undefined ? {} : { usage: round.usage },
        })
        await emit({ type: 'assistant-message', message: round.message, trace: round.trace })
        await emitAssistantContent(round, emit)
        // A failed or interrupted round that only began thinking has said
        // nothing new; it must not erase the text an earlier round produced.
        const roundText = textOf(round.message.content)
        if (roundText.trim() !== '' || (round.finish.kind !== 'error' && round.finish.kind !== 'aborted')) text = roundText
      } else if (round.finish.kind === 'stop') {
        // A successful empty round cannot answer new input with earlier text.
        // Keep earlier text only when a later request fails or is interrupted.
        text = ''
      }
    }
    // A failed request the retry hook may repeat is held back: kept in history,
    // its half-written text and cut-off call arguments would be continued from
    // (an answer missing its beginning) or rejected by the provider. It is
    // committed only if the turn ends on it.
    const retryCandidate = round.finish.kind === 'error' && !round.usageRequired
      && usageStop === undefined && !signal.aborted
    if (!retryCandidate) await commitRound()
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
      if (reason !== undefined) { await commitRound(); break }
      const decision = await runOptionalHook(options.hooks?.onRequestError, [{
        turn, step, failure: round.finish.failure, snapshot: options.history.snapshot(), signal,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        emit: emitMaintenance,
      }], options, signal, 'onRequestError')
        // A hook waiting out a backoff when the person aborts throws the abort;
        // that is a cancelled turn, not a crashed one.
        .catch((error: unknown) => { if (signal.aborted) return 'fail' as const; throw error })
      const maintenanceStop = accountingUsageStop(options.accounting)
      if (maintenanceStop !== undefined) { await commitRound(); reason = signal.aborted ? { kind: 'aborted' } : maintenanceStop; break }
      if (decision === 'retry' && !signal.aborted) {
        if (retriedRounds < MAX_FREE_REQUEST_RETRIES) retriedRounds++
        if (workSteps() < (finalizeUntil ?? maxSteps)) continue
      }
      await commitRound()
      reason = signal.aborted ? { kind: 'aborted' } : { kind: 'error', failure: round.finish.failure }
      break
    }
    if (round.finish.kind === 'max-tokens' && !round.usageRequired) { reason = { kind: 'max-tokens' }; break }
    if (round.calls.length === 0 && round.usageUnavailable) {
      reason = accountingUsageStop(options.accounting) ?? { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
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
      const final = await retryFinalRound(await modelRound(
        options, signal, emit, emitMaintenance, root, turn, steps + 1, 'final', position(),
      ), 'final')
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
        reason = accountingUsageStop(options.accounting) ?? { kind: 'usage-unavailable', modelCallId: final.report?.modelCallId ?? 'unknown' }
      } else reason = { kind: 'completed' }
      break
    }
    // A provider that repeated an id had the repeat dropped. Saying so is what
    // keeps the model from reading one result for two calls as a tool that
    // silently ignored it.
    if (round.droppedDuplicateCalls !== undefined) {
      options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-duplicate-guard' },
        content: [{
          type: 'text',
          text: `You reused the tool-call id ${round.droppedDuplicateCalls.map(id => `'${id}'`).join(', ')}.`
            + ' A result pairs to exactly one call, so the repeat was not run and only the first'
            + ' call of that id has a result. Give every call its own id, and call again if you'
            + ' still need what the dropped one would have done.',
        }],
      }) })
    }
    if (round.calls.length === 0 || options.tools === undefined) { reason = { kind: 'completed' }; break }

    // Calls the budget does not govern: submitting, asking, delegating. They
    // are dispatched even when the budget is spent, so the model always has a
    // legal way to finish. See `ToolDefinition.budgetExempt`.
    const remaining = Math.max(0, bounds.maxToolCalls - toolCalls)
    let repeatProjection: { key: string; count: number } | undefined = lastRepeat
    const projectedRepeats = round.calls.map(call => {
      const key = repeatKey(call)
      // Count consecutive calls, not lifetime visits to a source or test command.
      // Distinct intervening work may change its result. Alternating loops are
      // handled separately by the step-cycle guard below.
      const count = repeatProjection?.key === key ? repeatProjection.count + 1 : 1
      repeatProjection = { key, count }
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
      && budgetTokens >= maxTotalTokens
    // A model round that ran past the time budget does not start new work.
    const timeLimitBeforeDispatch = finalizeUntil === undefined && timeSpent() >= maxTurnDurationMs
    const guardDeclined = cycleLimitBeforeDispatch || tokenLimitBeforeDispatch || round.usageRequired
      || finalizeUntil !== undefined || timeLimitBeforeDispatch
    // Name the limit that actually declined the call. Reporting a repeat guard
    // as an empty budget teaches the model the wrong lesson, and it repeats the
    // call on the next turn with the budget it was told it lacked.
    const declineReason: ToolDeclineReason = finalizeReason !== undefined && !tokenLimitBeforeDispatch
      ? finalizeReason
      : tokenLimitBeforeDispatch
      ? 'tokens'
      : timeLimitBeforeDispatch
      ? 'time'
      : cycleLimitBeforeDispatch
        ? 'tool-call-cycle'
        : round.usageRequired
          ? 'usage-required'
          : 'tool-calls'
    // `continue` takes the wall down: the budget becomes a notice and the turn
    // is bounded by steps, tokens, and the run-level ledger instead. Guards
    // that mean "this is not working" still decline, whatever the setting.
    const budgetIsAWall = bounds.onExhausted !== 'continue'
    const recoveredCallIds = new Set<string>()
    // A round-wide guard must not make an unrelated old success reusable.
    // Recovery is only legal for a call that individually reached the limit and
    // whose successful result is the immediately preceding call in this streak.
    const individuallyRepeatedCallIds = new Set(round.calls
      .filter((_call, index) => (projectedRepeats[index] ?? 0) >= bounds.repeatToolLimit)
      .map(call => String(call.callId)))
    // Only ordinary dispatches request quota: repeated calls are either recovered
    // for free or individually declined. Fresh siblings keep normal admission.
    const budgetedCalls = round.calls.filter(call =>
      !individuallyRepeatedCallIds.has(String(call.callId))
      && options.tools?.get(call.toolName)?.budgetExempt !== true).length
    const recover = repeatedLimitBeforeDispatch && !cycleLimitBeforeDispatch && !tokenLimitBeforeDispatch
      && !round.usageRequired
      ? (call: typeof round.calls[number]): ToolExecutionResult | undefined => {
          const prior = successfulCalls.get(repeatKey(call))
          if (!individuallyRepeatedCallIds.has(String(call.callId))
            || lastRepeat?.key !== repeatKey(call)
            || lastRepeat.succeeded !== true
            || prior === undefined
            || prior.callId !== lastRepeat.callId
            || prior.rawArguments !== call.rawArguments
            || prior.definition !== options.tools?.get(call.toolName)
            || prior.result.additionalContext !== undefined
            || prior.result.concludesTurn === true
            || options.tools?.get(call.toolName)?.budgetExempt === true) return undefined
          recoveredCallIds.add(String(call.callId))
          return duplicateOfResult(prior)
        }
      : undefined
    const scheduled = await scheduleToolCalls({
      calls: round.calls, catalog: options.tools, history: options.history,
      position: { turn, step,
        ...(options.accounting === undefined ? {} : { runId: options.accounting.runId }),
        ...(options.trace?.conversationId === undefined ? {} : { conversationId: options.trace.conversationId }),
      }, signal, parentTrace: root,
      maxParallel: bounds.maxParallel,
      dispatchLimit: guardDeclined ? 0 : budgetIsAWall ? remaining : round.calls.length,
      declineReason,
      maxResultBytes: bounds.maxToolResultBytes,
      maxResultTokens: bounds.maxToolResultTokens,
      resultOverflow: bounds.toolResultOverflow,
      ...options.spillStore === undefined ? {} : { spillStore: options.spillStore },
      maxDurationMs: bounds.maxToolDurationMs,
      teardownTimeoutMs: bounds.toolTeardownTimeoutMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
      ...options.approvals === undefined ? {} : { approvals: options.approvals },
      ...options.accounting === undefined ? {} : { accounting: options.accounting },
      emit,
      ...recover === undefined ? {} : { recover },
      ...options.hooks?.checkpoint === undefined ? {} : {
        checkpoint: (context: Parameters<NonNullable<TurnHooks['checkpoint']>>[0]) => runHook(
          Promise.resolve(options.hooks?.checkpoint?.(context)), options, signal, 'checkpoint',
        ),
      },
    }, {
      onToolActivity: toolActivity,
      admissionLimit: guardDeclined ? 0 : budgetIsAWall ? remaining : 'unbounded',
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
      ...programs === undefined ? {} : { programs },
      ...programResults === undefined ? {} : { programResults },
    })
    // Results commit in model order, one per requested call, so the pairing
    // holds for declined calls too. A short result list means a sibling failed
    // its contract and the turn is already unwinding; reporting a guessed
    // outcome would be worse than reporting nothing.
    if (contextSections !== undefined && scheduled.results.length === round.calls.length) {
      contextTouches.push(...round.calls.map((call, index) => ({
        toolName: call.toolName,
        rawArguments: call.rawArguments,
        failed: scheduled.results[index]?.isError ?? true,
      })))
    }
    toolCalls += scheduled.budgeted
    const remainingAfterDispatch = Math.max(0, bounds.maxToolCalls - toolCalls)
    // One reminder per threshold crossed, not one per turn.
    //
    // This was a single boolean: the model was told once, at 25% remaining,
    // and then never again however close it came to the end. A model warned at
    // sixteen calls left and still exploring at four has been told nothing
    // since, and runs into the wall with no notice — which is what produces a
    // red "no remaining tool-call budget" where an answer should have been.
    //
    // Codex counts thresholds rather than remembering a flag
    // (`rollout_budget.rs`, `reminder_index`): every threshold now below the
    // remaining budget that has not been reported yet gets reported. Crossing
    // several at once collapses into the one that matters, the lowest.
    const crossed = budgetReminders.filter(threshold => remainingAfterDispatch <= threshold).length
    if (crossed > budgetRemindersSent && remainingAfterDispatch > 0) {
      budgetRemindersSent = crossed
      appendBudgetNotice(
        `Tool budget: ${remainingAfterDispatch} of ${bounds.maxToolCalls} calls remain in this turn.`
        + ' Stop broad exploration, make the necessary edits, and reserve calls for'
        + (budgetIsAWall
          ? ' verification. When the budget runs out no further work call will run, so'
            + ' finish with what you can still verify.'
          : ' verification. Past the budget you are expected to be wrapping up, not'
            + ' opening new lines of work.'),
      )
    }
    // Past the budget with the wall down. The turn is not stopped — the model
    // keeps its tools — but it is told, once per further budget spent, that it
    // is now expected to be finishing. This is the shape of Codex's
    // `budget_limit` goal prompt: no new substantive work, wrap up, name what
    // is left.
    if (!budgetIsAWall && remainingAfterDispatch === 0) {
      const windows = Math.floor(toolCalls / bounds.maxToolCalls)
      if (windows > overBudgetNoticesSent) {
        overBudgetNoticesSent = windows
        appendBudgetNotice(
          `Tool budget spent: ${toolCalls} calls made against a budget of ${bounds.maxToolCalls}.`
          + ' Do not start new substantive work. Finish what is in flight, verify what you'
          + ' can, and answer — stating plainly what is unverified or unfinished.',
        )
      }
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
      const count = lastRepeat?.key === key ? lastRepeat.count + 1 : 1
      lastRepeat = {
        key, count, callId: String(call.callId),
        succeeded: !result.isError && result.meta?.declined !== true
          && options.tools?.get(call.toolName)?.budgetExempt !== true,
      }
      if (count === bounds.repeatToolWarningAt) {
        options.history.append({ kind: 'user', message: createUserMessage({
          source: { kind: 'app', producer: 'tool-loop-repeat-guard' },
          content: [{ type: 'text', text: `You have called ${call.toolName} with the same arguments ${count} consecutive times. Reassess before repeating it.` }],
        }) })
      }
      if (count >= bounds.repeatToolLimit) repeatedLimit = true
      if (!result.isError && result.meta?.declined !== true
        && options.tools?.get(call.toolName)?.budgetExempt !== true) {
        successfulCalls.set(key, {
          callId: String(call.callId), rawArguments: call.rawArguments,
          definition: options.tools.get(call.toolName), result,
        })
      }
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
      reason = accountingUsageStop(options.accounting) ?? { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
      break
    }
    let exhausted: ExhaustedBudget | undefined
    const reportReserveReached = bounds.maxTotalTokens !== 'auto'
      && bounds.finalReportReserveTokens > 0 && budgetTokens !== undefined
      && budgetTokens >= maxTotalTokens - bounds.finalReportReserveTokens
    const recoveredOnlyReplan = repeatedLimitBeforeDispatch
      && recoveredCallIds.size === round.calls.length
      && round.calls.every(call => recoveredCallIds.has(String(call.callId))
        && !recoveredReplanKeys.has(repeatKey(call)))
      && scheduled.results.length === round.calls.length
      && scheduled.results.every(result => !result.isError)
      && scheduled.dispatched === 0 && scheduled.declined === 0
      && !cycleLimitBeforeDispatch && !tokenLimitBeforeDispatch && !reportReserveReached
      && !round.usageRequired && !round.usageUnavailable && !signal.aborted
      && !(budgetIsAWall && budgetedCalls > remaining)
      && consecutiveErrors === 0 && workSteps() < maxSteps
      && bounds.onExhausted !== 'stop' && admissionStop() === undefined
    // A repeated call cannot poison new work in the same model batch. Successful
    // recovery alongside a real dispatch is ordinary progress, not an extra pure
    // duplicate replan. The other exhaustion checks below still apply.
    const recoveredWithFreshDispatch = repeatedLimitBeforeDispatch
      && [...individuallyRepeatedCallIds].every(id => recoveredCallIds.has(id))
      && scheduled.results.length === round.calls.length
      && scheduled.dispatched > 0 && scheduled.declined === 0
    if (recoveredOnlyReplan) {
      for (const call of round.calls) recoveredReplanKeys.add(repeatKey(call))
    } else if (tokenLimitBeforeDispatch) exhausted = 'tokens'
    else if (reportReserveReached) exhausted = 'tokens'
    else if (cycleLimitBeforeDispatch) exhausted = 'tool-call-cycle'
    else if (budgetIsAWall && budgetedCalls > remaining) exhausted = 'tool-calls'
    else if (consecutiveErrors >= bounds.maxConsecutiveToolErrors) exhausted = 'consecutive-tool-errors'
    else if (repeatedLimit && !recoveredWithFreshDispatch) exhausted = 'repeated-tool-call'
    else if (workSteps() >= maxSteps) exhausted = 'steps'
    // The finalize window has its own end; only the hard token wall stops it early.
    if (finalizeUntil !== undefined) exhausted = tokenLimitBeforeDispatch ? 'tokens' : undefined
    if (exhausted === undefined && recoveredWithFreshDispatch) {
      for (const call of round.calls) {
        if (recoveredCallIds.has(String(call.callId))) recoveredReplanKeys.add(repeatKey(call))
      }
    }
    // Time is checked at every step boundary, not only after tool work.
    if (exhausted === undefined && finalizeUntil === undefined && timeSpent() >= maxTurnDurationMs) exhausted = 'time'
    if (exhausted !== undefined) {
      const forced = (exhausted !== 'tokens' || (reportReserveReached && !tokenLimitBeforeDispatch))
        && bounds.onExhausted !== 'stop'
        && admissionStop() === undefined
      reason = forced
        ? await forceAnswer(exhausted, exhausted === 'tokens' && reportReserveReached && !tokenLimitBeforeDispatch)
        : { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: false,
          ...(exhausted === 'tokens' && reportReserveReached && !tokenLimitBeforeDispatch ? { trigger: 'report-reserve' as const } : {}) }
    }
  }

  // The window is for an answer written with no step left to confirm it:
  // either forced by a budget, or written freely on the last work step. Input
  // a person sent meanwhile is not answered in a tool-less window; the turn
  // ends instead and that input gets a turn of its own.
  const finalizable = reason?.kind === 'budget-exhausted'
    ? reason.forcedFinalAnswer
    : reason?.kind === 'completed' && workSteps() >= maxSteps
  if (finalizeUntil === undefined && options.finalize !== undefined && bounds.finalizeSteps > 0
    && (reason?.kind === 'budget-exhausted' || reason?.kind === 'completed') && finalizable
    && text.trim() !== '' && !signal.aborted && admissionStop() === undefined
    && !hasQueuedInput(options.history)) {
    const prompt = options.finalize.prompt({ text, reason })
    if (prompt !== undefined) {
      options.history.append({ kind: 'user', message: prompt })
      finalizeOrigin = reason
      finalizeReason = reason.kind === 'budget-exhausted' ? reason.budget : 'steps'
      forcedText = text
      forcedMessage = options.history.messages().findLast(message => message.role === 'assistant')
      finalizeUntil = workSteps() + bounds.finalizeSteps
      reason = undefined
      continue turnLifecycle
    }
  }
  if (reason === undefined) {
    reason = signal.aborted
      ? { kind: 'aborted' }
      : { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: false }
  }
  // Confirming a forced answer does not un-spend the budget, and a failed or
  // cut-short confirmation does not cost the answer: the turn ends with the
  // stop that opened the window, and with the forced answer unless the window
  // itself ended on a new one. A person's abort stays an abort.
  if (finalizeOrigin !== undefined) {
    const confirmedAnswer = reason.kind === 'completed' && text.trim() !== '' && options.finalize?.confirmed() === true
    if (!confirmedAnswer) {
      text = forcedText
      // The kept answer must also be the last thing said, or the session's
      // message, the stream and a reload would show the window's note instead.
      const last = options.history.messages().findLast(message => message.role === 'assistant')
      if (forcedMessage !== undefined && last?.id !== forcedMessage.id) {
        const restored = createMessage({ role: 'assistant', content: forcedMessage.content, source: forcedMessage.source })
        options.history.append({ kind: 'assistant', message: restored })
        await emit({ type: 'assistant-message', message: restored, trace: root })
      }
    }
    if (reason.kind !== 'aborted') reason = finalizeOrigin
  }
  const usageReport = summarizeModelCallUsage(modelCallReports)
  const usage = authoritativeTokenUsage(usageReport)
  const candidate: TurnOutcome = {
    reason, text, steps, usageReport, toolCalls, traceId,
    ...usage === undefined ? {} : { usage },
  }
  const entriesBeforeHook = options.history.entries().length
  const canContinue = reason.kind === 'completed'
    && workSteps() < maxSteps
    && admissionStop() === undefined
  await runOptionalHook(options.hooks?.onTurnEnd, [{
    outcome: candidate,
    snapshot: options.history.snapshot(),
    canContinue,
  }], options, signal.aborted ? new AbortController().signal : signal, 'onTurnEnd')
  // Hooks object by appending context rather than by returning a veto. Re-run only
  // a normally completed turn; abort/error/budget outcomes remain terminal.
  // Input the person sent while the final answer was being written is owed an
  // answer too: when nothing else continues the turn, take it and continue.
  if (canContinue
    && !signal.aborted
    && (options.history.entries().length > entriesBeforeHook || deliverQueuedInput(options.history))) {
    reason = undefined
    continue turnLifecycle
  }
  outcome = candidate
  break
  }
  if (outcome.reason.kind === 'aborted') {
    // Without this, the next turn sees an unfinished request and a cancelled
    // tool call, and a model resumes the abandoned work instead of answering
    // the new message (observed live). Codex and Claude Code record the same
    // interruption marker.
    options.history.append({ kind: 'user', message: createUserMessage({
      source: { kind: 'app', producer: 'turn-interrupted' },
      content: [{ type: 'text', text: 'The previous request was interrupted before it finished. Use the next message to determine what to do next.' }],
    }) })
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
  } finally {
    programResults?.close()
  }
}

function duplicateOfResult(prior: {
  readonly callId: string
  readonly result: Extract<ToolExecutionResult, { readonly isError: false }>
}): ToolExecutionResult {
  return detachedFrozen({
    isError: false,
    // The prior structured value remains the host's canonical result. The
    // header is model-visible so it knows this call was intentionally reused.
    value: prior.result.value,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'duplicate_of',
          callId: prior.callId,
          instruction: 'This exact call already succeeded in this run. Use the retained result below; do not call it again.',
        }),
      },
      ...prior.result.content,
    ],
    meta: { ...prior.result.meta, recovered: true, duplicateOfCallId: prior.callId },
  })
}

export type { RunTurnOptions } from './turn/types.ts'
