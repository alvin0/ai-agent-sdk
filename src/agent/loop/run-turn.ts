import type { CallConfig } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { NativeToolSchema, ToolChoice } from '@ai-agent-sdk/core'
import type { ModelFailure } from '@ai-agent-sdk/core'
import type { ContentBlock, ToolCallBlock } from '@ai-agent-sdk/core'
import { createMessage, createUserMessage, type Message } from '@ai-agent-sdk/core'
import { BlockAssembler } from '@ai-agent-sdk/core'
import type { FinishReason, StreamChunk, TokenUsage } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import { detachedFrozen } from '@ai-agent-sdk/core'
import type { ModelRegistry } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import { History } from '../history/history.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolInterceptor, ToolCallRequest } from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { createSpanId, createTraceId, type SpanId, type TraceId, type TraceRef } from '../trace/trace.ts'
import type { AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, ExhaustedBudget, TurnBounds, TurnHooks, TurnOutcome } from './types.ts'
import { AwaitedEventQueue } from './queue.ts'
import { runToolCalls } from './schedule.ts'

export interface RunTurnOptions {
  readonly registry: ModelRegistry
  readonly config: CallConfig
  readonly history: History
  readonly tools?: ToolCatalog
  /** Tools executed inside the provider response (web search, image generation). */
  readonly nativeTools?: readonly NativeToolSchema[]
  /** Optional provider-neutral selection constraint for host or native tools. */
  readonly toolChoice?: ToolChoice
  readonly system?: string
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly bounds?: Partial<TurnBounds>
  readonly hooks?: TurnHooks
  readonly signal?: AbortSignal
  /** Maximum wait for an uncooperative producer after the event consumer stops. Defaults to 30s. */
  readonly teardownTimeoutMs?: number
  /** Total wall-clock allowance for one model stream, including adapter preparation. Defaults to 10m. */
  readonly modelTimeoutMs?: number
  /** Maximum serialized request bytes passed to a model adapter. Defaults to 32 MiB. */
  readonly maxModelRequestBytes?: number
  /** Maximum serialized response bytes accepted from one model stream. Defaults to 32 MiB. */
  readonly maxModelResponseBytes?: number
  /** Maximum chunks accepted from one model stream. Defaults to 100,000. */
  readonly maxModelStreamEvents?: number
  /** Maximum wall time for one policy/lifecycle hook. Defaults to 10 minutes. */
  readonly hookTimeoutMs?: number
  /** Maximum wait after a timed-out hook ignores cancellation. Defaults to 30 seconds. */
  readonly hookTeardownTimeoutMs?: number
  /** Ask the model for concise user-visible progress narration around tool use. */
  readonly commentary?: 'auto' | 'concise' | 'off'
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
    readonly conversationId?: string
    readonly agentId?: string
    readonly agentName?: string
  }
}

const DEFAULT_BOUNDS: TurnBounds = Object.freeze({
  maxSteps: 16,
  maxToolCalls: 64,
  onExhausted: 'force-final-answer',
  maxConsecutiveToolErrors: 8,
  repeatToolWarningAt: 3,
  repeatToolLimit: 6,
  toolCycleWarningAt: 2,
  toolCycleLimit: 3,
  maxToolCycleLength: 4,
  maxTotalTokens: 500_000,
  maxParallel: 8,
  maxToolResultBytes: 4 * 1024 * 1024,
  maxToolDurationMs: 10 * 60_000,
  toolTeardownTimeoutMs: 30_000,
})

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
  let usage = zeroUsage()
  let reason: TurnOutcome['reason'] | undefined
  let outcome: TurnOutcome
  const repeats = new Map<string, number>()
  const actionSteps: string[] = []
  const emitMaintenance = maintenanceEmitter(emit, root)
  let rootStarted = false
  let rootEnded = false

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
    const step = steps + 1
    const round = await modelRound(options, signal, emit, emitMaintenance, root, turn, step, false)
    steps++
    usage = addUsage(usage, round.usage)
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
    if (round.finish.kind === 'aborted') { reason = { kind: 'aborted' }; break }
    if (round.finish.kind === 'error') {
      const decision = await runOptionalHook(options.hooks?.onRequestError, [{
        turn, step, failure: round.finish.failure, snapshot: options.history.snapshot(), signal,
        emit: emitMaintenance,
      }], options, signal, 'onRequestError')
      if (decision === 'retry' && steps < bounds.maxSteps) continue
      reason = { kind: 'error', failure: round.finish.failure }
      break
    }
    if (round.finish.kind === 'max-tokens') { reason = { kind: 'max-tokens' }; break }
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
    const tokenLimitBeforeDispatch = usage.totalTokens !== undefined
      && usage.totalTokens >= bounds.maxTotalTokens
    const guardDeclined = repeatedLimitBeforeDispatch || cycleLimitBeforeDispatch || tokenLimitBeforeDispatch
    const scheduled = await runToolCalls({
      calls: round.calls, catalog: options.tools, history: options.history,
      position: { turn, step }, signal, parentTrace: root,
      maxParallel: bounds.maxParallel, dispatchLimit: guardDeclined ? 0 : remaining,
      maxResultBytes: bounds.maxToolResultBytes,
      maxDurationMs: bounds.maxToolDurationMs,
      teardownTimeoutMs: bounds.toolTeardownTimeoutMs,
      ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
      ...options.approvals === undefined ? {} : { approvals: options.approvals },
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
        && !signal.aborted
      if (forced) {
        const final = await modelRound(options, signal, emit, emitMaintenance, root, turn, steps + 1, true)
        steps++
        usage = addUsage(usage, final.usage)
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
      }
      reason = { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: forced }
    }
  }

  if (reason === undefined) {
    reason = signal.aborted
      ? { kind: 'aborted' }
      : { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: false }
  }
  const candidate: TurnOutcome = { reason, text, steps, usage, toolCalls, traceId }
  const entriesBeforeHook = options.history.entries().length
  const canContinue = reason.kind === 'completed'
    && steps < bounds.maxSteps
    && !signal.aborted
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
    output: { reason: outcome.reason, text }, usage,
    ...outcome.reason.kind === 'error' ? { error: { type: 'ModelError', message: outcome.reason.failure.message, code: outcome.reason.failure.code } } : {},
  })
  rootEnded = true
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
    throw error
  }
}

interface RoundResult {
  readonly trace: TraceRef
  readonly message?: Message
  readonly finish: FinishReason
  readonly usage?: TokenUsage
  readonly calls: readonly ToolCallRequest[]
  readonly afterToolCallIds: readonly ToolCallId[]
  readonly timing: AssistantContentTiming
}

async function modelRound(
  options: RunTurnOptions,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
  emitMaintenance: (event: AgentMaintenanceEvent) => Promise<void>,
  root: TraceRef,
  turn: number,
  step: number,
  forcedFinal: boolean,
): Promise<RoundResult> {
  const trace: TraceRef = { traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId }
  let messages = normalizeToolPairing(options.history.messages())
  const afterToolCallIds = recentToolResultIds(options.history)
  const generation = options.history.generation()
  const entries = options.history.entries().length
  const decision = await runOptionalHook(options.hooks?.beforeStep, [{
    turn, step, messages, snapshot: options.history.snapshot(), signal,
    emit: emitMaintenance,
  }], options, signal, 'beforeStep')
  if (decision?.kind === 'reject') {
    const failure: ModelFailure = { message: decision.reason, code: 'STEP_REJECTED' }
    return {
      trace, finish: { kind: 'error', failure }, calls: [], afterToolCallIds,
      timing: contentTiming(false, afterToolCallIds.length > 0),
    }
  }
  // Hooks may append live steering as well as replacing compacted history.
  // Refresh for either mutation so new user input stays at the chronological
  // tail instead of needing to be prepended ahead of older history.
  if (options.history.generation() !== generation
    || options.history.entries().length !== entries) {
    messages = normalizeToolPairing(options.history.messages())
  }
  if (decision?.prepend !== undefined) messages = Object.freeze([...decision.prepend, ...messages])
  const system = systemText(options, forcedFinal)
  const tools = [
    ...options.tools?.schemas() ?? [],
    ...options.nativeTools ?? [],
  ]
  const requestBase: GenerateOptions = {
    ...options.config,
    messages,
    ...system.length === 0 ? {} : { system },
    ...tools.length === 0 ? {} : { tools },
    ...forcedFinal
      ? { toolChoice: 'none' as const }
      : options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice },
  }
  const checkpointRequest: GenerateOptions = { ...requestBase, signal }
  try {
    await runOptionalHook(options.hooks?.checkpoint, [{
      kind: 'before-model-request', request: checkpointRequest,
      snapshot: options.history.snapshot(), signal,
    }], options, signal, 'checkpoint')
  } catch (error: unknown) {
    const failure: ModelFailure = { message: `history checkpoint failed: ${messageOf(error)}`, code: 'CHECKPOINT_FAILED' }
    return {
      trace, finish: { kind: 'error', failure }, calls: [], afterToolCallIds,
      timing: contentTiming(false, afterToolCallIds.length > 0),
    }
  }
  await emit({ type: 'span-start', trace, at: now(), name: `chat ${options.config.model}`, kind: 'chat', attributes: {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': options.config.model,
    turn, step, forcedFinal,
  } })
  await emit({ type: 'step-start', turn, step, trace, ...forcedFinal ? { forcedFinal: true as const } : {} })
  const assembler = new BlockAssembler()
  const modelTimeoutMs = positiveFinite(options.modelTimeoutMs ?? 10 * 60_000, 'modelTimeoutMs')
  const maxRequestBytes = positiveSafeInteger(options.maxModelRequestBytes ?? 32 * 1024 * 1024, 'maxModelRequestBytes')
  const maxResponseBytes = positiveSafeInteger(options.maxModelResponseBytes ?? 32 * 1024 * 1024, 'maxModelResponseBytes')
  const maxStreamEvents = positiveSafeInteger(options.maxModelStreamEvents ?? 100_000, 'maxModelStreamEvents')
  const teardownTimeoutMs = positiveFinite(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  let requestBytes: number
  try {
    requestBytes = serializedBytes(requestBase)
  } catch (error: unknown) {
    requestBytes = -1
    assembler.push(modelFailureFinish(`model request is not serializable: ${messageOf(error)}`, 'INVALID_MODEL_REQUEST'))
  }
  if (requestBytes > maxRequestBytes) {
    assembler.push(modelFailureFinish(
      `model request exceeds the ${maxRequestBytes}-byte limit`,
      'MODEL_REQUEST_TOO_LARGE',
    ))
  } else if (requestBytes >= 0) {
    const owned = new AbortController()
    const roundSignal = AbortSignal.any([signal, owned.signal])
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      owned.abort(new Error(`model stream exceeded ${modelTimeoutMs}ms`))
    }, modelTimeoutMs)
    const iterator = options.registry.stream({ ...requestBase, signal: roundSignal })[Symbol.asyncIterator]()
    let exhausted = false
    let events = 0
    let responseBytes = 0
    let sawFinish = false
    try {
      while (true) {
        const next = await nextWithAbort(iterator.next(), roundSignal)
        if (next.done === true) {
          exhausted = true
          break
        }
        const chunk = next.value
        try {
          validateStreamChunk(chunk, maxStreamEvents)
        } catch (error: unknown) {
          assembler.push(modelFailureFinish(
            `model adapter emitted an invalid stream chunk: ${messageOf(error)}`,
            'INVALID_MODEL_STREAM',
          ))
          owned.abort(new Error('invalid model stream chunk'))
          break
        }
        events++
        try {
          responseBytes += serializedBytes(chunk)
        } catch (error: unknown) {
          assembler.push(modelFailureFinish(
            `model adapter emitted a non-serializable stream chunk: ${messageOf(error)}`,
            'INVALID_MODEL_STREAM',
          ))
          owned.abort(new Error('non-serializable model stream chunk'))
          break
        }
        if (events > maxStreamEvents || responseBytes > maxResponseBytes) {
          const dimension = events > maxStreamEvents
            ? `${maxStreamEvents}-event`
            : `${maxResponseBytes}-byte`
          assembler.push(modelFailureFinish(
            `model response exceeds the ${dimension} limit`,
            'MODEL_RESPONSE_TOO_LARGE',
          ))
          owned.abort(new Error('model response resource limit exceeded'))
          break
        }
        if (sawFinish) {
          assembler.push(modelFailureFinish(
            'model adapter emitted data after its terminal finish chunk',
            'INVALID_MODEL_STREAM',
          ))
          owned.abort(new Error('invalid model stream'))
          break
        }
        assembler.push(chunk)
        if (chunk.type === 'finish') sawFinish = true
        if (chunk.type === 'text-delta') await emit({
          type: 'text-delta', index: chunk.index, text: chunk.text,
          phase: chunk.phase ?? 'unknown', trace,
        })
        else if (chunk.type === 'reasoning-delta') await emit({
          type: 'reasoning-delta', index: chunk.index, text: chunk.text, trace,
        })
        else if (chunk.type === 'image-delta') await emit({
          type: 'image-delta', itemId: chunk.itemId, data: chunk.data,
          mediaType: chunk.mediaType, ...chunk.partialIndex === undefined ? {} : { partialIndex: chunk.partialIndex }, trace,
        })
        else if (chunk.type === 'usage') await emit({ type: 'usage', usage: chunk.usage, trace })
      }
    } catch (error: unknown) {
      if (!(error instanceof StreamAbortError)) throw error
      assembler.push(signal.aborted
        ? modelAbortedFinish(messageOf(signal.reason ?? error))
        : timedOut
          ? modelFailureFinish(`model stream exceeded ${modelTimeoutMs}ms`, 'MODEL_TIMEOUT')
          : modelFailureFinish(messageOf(error.cause ?? error), 'MODEL_STREAM_ABORTED'))
    } finally {
      clearTimeout(timeout)
      if (!exhausted) {
        owned.abort(new Error('model stream closed before exhaustion'))
        const settled = await closeIterator(iterator, teardownTimeoutMs)
        if (!settled) {
          assembler.push(modelFailureFinish(
            `model stream ignored cancellation for more than ${teardownTimeoutMs}ms; the adapter operation may still be running`,
            'MODEL_TEARDOWN_TIMEOUT',
          ))
        }
      }
    }
  }
  let providerFinish = assembler.finish
  let rawBlocks: ContentBlock[]
  try {
    rawBlocks = providerFinish.kind === 'aborted' ? assembler.interruptedBlocks() : assembler.blocks()
  } catch (error: unknown) {
    providerFinish = {
      kind: 'error',
      failure: {
        message: `model adapter emitted an invalid block sequence: ${messageOf(error)}`,
        code: 'INVALID_MODEL_STREAM',
      },
    }
    rawBlocks = []
  }
  const classified = classifyTextPhases(rawBlocks)
  const invalidCall = invalidHostToolCall(classified, options.history)
  const blocks = invalidCall === undefined
    ? classified
    : classified.filter(block => block.type !== 'tool-call')
  const finish: FinishReason = invalidCall === undefined
    ? providerFinish
    : { kind: 'error', failure: invalidCall }
  const message = blocks.length === 0 && (finish.kind === 'error' || finish.kind === 'aborted')
    ? undefined
    : createAssistant(options, blocks, assembler.replayState)
  const calls = message?.content
    .filter((block): block is ToolCallBlock => block.type === 'tool-call')
    .map(block => ({ callId: block.id, toolName: block.name, rawArguments: block.arguments })) ?? []
  const timing = contentTiming(calls.length > 0, afterToolCallIds.length > 0)
  await emit({
    type: 'span-end', trace, at: now(),
    status: finish.kind === 'error' ? 'error' : finish.kind === 'aborted' ? 'aborted' : 'success',
    output: message === undefined ? undefined : {
      text: textOf(message.content),
      commentary: message.content.flatMap(block => block.type === 'text' && block.phase === 'commentary' ? [block.text] : []),
      reasoning: message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []),
      toolCalls: calls.length,
    },
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    ...finish.kind === 'error' || finish.kind === 'aborted'
      ? { error: { type: 'ModelError', message: finish.failure.message, code: finish.failure.code } }
      : {},
  })
  if (calls.length === 0 || forcedFinal) await emit({ type: 'step-end', turn, step, trace })
  return {
    trace, ...message === undefined ? {} : { message }, finish,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    calls, afterToolCallIds, timing,
  }
}

function maintenanceEmitter(
  emit: (event: AgentEvent) => Promise<void>,
  root: TraceRef,
): (event: AgentMaintenanceEvent) => Promise<void> {
  const spans = new Map<string, TraceRef>()
  return async event => {
    if (event.type === 'compaction-start') {
      const trace: TraceRef = {
        traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId,
      }
      spans.set(event.compactionId, trace)
      await emit({
        type: 'span-start', trace, at: now(),
        name: `compact ${event.trigger}`, kind: 'compact',
        attributes: {
          'gen_ai.operation.name': 'compact',
          'gen_ai.compaction.id': event.compactionId,
          'gen_ai.compaction.trigger': event.trigger,
          'gen_ai.input.tokens.estimated': event.estimatedInputTokens,
        },
      })
      await emit({ ...event, trace })
      return
    }
    const trace = spans.get(event.compactionId) ?? root
    await emit({ ...event, trace })
    await emit({
      type: 'span-end', trace, at: now(), status: event.status === 'completed' ? 'success' : 'error',
      output: {
        shadowedSeqs: event.shadowedSeqs,
        estimatedTokensBefore: event.estimatedTokensBefore,
        estimatedTokensAfter: event.estimatedTokensAfter,
        ...(event.thresholdTokens === undefined ? {} : { thresholdTokens: event.thresholdTokens }),
        ...(event.estimatedNonCompactableTokens === undefined
          ? {} : { estimatedNonCompactableTokens: event.estimatedNonCompactableTokens }),
        ...(event.backoffReason === undefined ? {} : { backoffReason: event.backoffReason }),
      },
      ...(event.usage === undefined ? {} : { usage: event.usage }),
      ...(event.error === undefined ? {} : {
        error: { type: 'CompactionError', message: event.error },
      }),
    })
    spans.delete(event.compactionId)
  }
}

async function emitAssistantContent(
  round: RoundResult,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  const message = round.message
  if (message === undefined) return
  const toolCallIds = Object.freeze(round.calls.map(call => call.callId))
  for (const block of message.content) {
    if (block.type === 'text' && block.text.length > 0) {
      await emit({
        type: 'assistant-text', trace: round.trace, messageId: message.id, text: block.text,
        phase: block.phase ?? (round.calls.length > 0 ? 'commentary' : 'final-answer'),
        timing: round.timing, toolCallIds, afterToolCallIds: round.afterToolCallIds,
      })
    } else if (block.type === 'reasoning' && block.text.length > 0) {
      await emit({
        type: 'assistant-reasoning', trace: round.trace, messageId: message.id, text: block.text,
        timing: round.timing, toolCallIds, afterToolCallIds: round.afterToolCallIds,
      })
    } else if (block.type === 'native-tool-call') {
      await emit({ type: 'assistant-native-tool', trace: round.trace, messageId: message.id, call: block })
    }
  }
}

function classifyTextPhases(blocks: readonly ContentBlock[]): ContentBlock[] {
  const hasHostCalls = blocks.some(block => block.type === 'tool-call')
  const lastNative = blocks.findLastIndex(block => block.type === 'native-tool-call')
  return blocks.map((block, index) => {
    if (block.type !== 'text' || block.phase !== undefined) return block
    const phase = hasHostCalls || (lastNative >= 0 && index < lastNative)
      ? 'commentary' as const
      : 'final-answer' as const
    return { ...block, phase }
  })
}

function invalidHostToolCall(
  blocks: readonly ContentBlock[],
  history: History,
): ModelFailure | undefined {
  const seen = new Set<string>()
  for (const entry of history.entries()) {
    if (entry.event.kind !== 'assistant') continue
    for (const block of entry.event.message.content) {
      if (block.type === 'tool-call') seen.add(block.id)
    }
  }
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (typeof block.id !== 'string' || block.id.trim().length === 0
      || typeof block.name !== 'string' || block.name.trim().length === 0
      || typeof block.arguments !== 'string') {
      return {
        message: 'provider emitted a host tool call with invalid identity, name, or arguments',
        code: 'INVALID_TOOL_CALL',
      }
    }
    if (seen.has(block.id)) {
      return {
        message: `provider emitted duplicate host tool call id '${block.id}'`,
        code: 'INVALID_TOOL_CALL',
      }
    }
    seen.add(block.id)
  }
  return undefined
}

function contentTiming(hasToolCalls: boolean, followsToolResults: boolean): AssistantContentTiming {
  if (hasToolCalls && followsToolResults) return 'between-tools'
  if (hasToolCalls) return 'before-tools'
  if (followsToolResults) return 'after-tools'
  return 'standalone'
}

function recentToolResultIds(history: History): readonly ToolCallId[] {
  const ids: ToolCallId[] = []
  const entries = history.entries()
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index]?.event
    if (event === undefined) continue
    if (event.kind === 'assistant' || (event.kind === 'user' && event.message.source.kind === 'user')) break
    if (event.kind === 'tool-result') ids.unshift(event.callId)
  }
  return Object.freeze(ids)
}

function systemText(options: RunTurnOptions, forcedFinal: boolean): string {
  const parts = [options.system]
  if (options.commentary === 'concise') {
    parts.push(
      'Before calling tools, give a brief user-visible progress update about what you are about to do. After tool results, briefly summarize what changed before another action. Do not reveal private chain-of-thought; communicate only intent and observed outcomes.',
    )
  } else if (options.commentary === 'off') {
    parts.push('Do not emit progress commentary around tool calls; call tools directly and provide only the final answer.')
  }
  if (forcedFinal) parts.push(
    'Tool use is now disabled. Answer from the information already gathered and state plainly what remains unknown.',
  )
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}

function createAssistant(options: RunTurnOptions, content: readonly ContentBlock[], replayState: unknown): Message {
  const source = {
    kind: 'model' as const, provider: options.config.provider, model: options.config.model,
    ...replayState === undefined ? {} : { replayState },
  }
  return createMessage({ role: 'assistant', content, source })
}

function resolveBounds(input: Partial<TurnBounds> | undefined): TurnBounds {
  const bounds = { ...DEFAULT_BOUNDS, ...input }
  for (const key of [
    'maxSteps', 'maxToolCalls', 'maxConsecutiveToolErrors', 'repeatToolWarningAt',
    'repeatToolLimit', 'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength',
    'maxTotalTokens', 'maxParallel', 'maxToolResultBytes', 'maxToolDurationMs',
    'toolTeardownTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) throw new RangeError(`${key} must be a positive safe integer`)
  }
  if (bounds.repeatToolLimit < bounds.repeatToolWarningAt) throw new RangeError('repeatToolLimit must be >= repeatToolWarningAt')
  if (bounds.toolCycleLimit < bounds.toolCycleWarningAt) {
    throw new RangeError('toolCycleLimit must be >= toolCycleWarningAt')
  }
  return Object.freeze(bounds)
}
function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}
function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}
function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}
function modelFailureFinish(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}
function modelAbortedFinish(message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
}
function validateStreamChunk(chunk: StreamChunk, maxBlockNodes: number): void {
  if (typeof chunk !== 'object' || chunk === null || typeof chunk.type !== 'string') {
    throw new TypeError('chunk must be an object with a type')
  }
  if ('index' in chunk && (!Number.isSafeInteger(chunk.index) || chunk.index < 0)) {
    throw new TypeError('chunk index must be a non-negative safe integer')
  }
  switch (chunk.type) {
    case 'block-start':
      if (typeof chunk.blockType !== 'string' || chunk.blockType.length === 0) throw new TypeError('blockType must be non-empty')
      return
    case 'text-delta':
      if (typeof chunk.text !== 'string') throw new TypeError('text delta must be a string')
      if (chunk.phase !== undefined && chunk.phase !== 'commentary' && chunk.phase !== 'final-answer') {
        throw new TypeError('text phase is invalid')
      }
      return
    case 'reasoning-delta':
      if (typeof chunk.text !== 'string') throw new TypeError('reasoning delta must be a string')
      return
    case 'image-delta':
      if (typeof chunk.itemId !== 'string' || typeof chunk.data !== 'string' || typeof chunk.mediaType !== 'string') {
        throw new TypeError('image delta fields must be strings')
      }
      if (chunk.partialIndex !== undefined
        && (!Number.isSafeInteger(chunk.partialIndex) || chunk.partialIndex < 0)) {
        throw new TypeError('image partialIndex must be a non-negative safe integer')
      }
      return
    case 'tool-call-delta':
      if (typeof chunk.id !== 'string' || chunk.id.length === 0
        || (chunk.name !== undefined && typeof chunk.name !== 'string')
        || typeof chunk.argumentsDelta !== 'string') {
        throw new TypeError('tool-call delta fields are invalid')
      }
      return
    case 'block-end':
      if (typeof chunk.block !== 'object' || chunk.block === null || typeof chunk.block.type !== 'string') {
        throw new TypeError('block-end must contain a content block')
      }
      validateContentBlock(chunk.block, maxBlockNodes)
      return
    case 'usage':
      validateUsageCount(chunk.usage.inputTokens, 'inputTokens')
      validateUsageCount(chunk.usage.outputTokens, 'outputTokens')
      for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
        if (chunk.usage[key] !== undefined) validateUsageCount(chunk.usage[key], key)
      }
      return
    case 'finish':
      if (typeof chunk.reason !== 'object' || chunk.reason === null || typeof chunk.reason.kind !== 'string') {
        throw new TypeError('finish reason is invalid')
      }
      if ((chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
        && (typeof chunk.reason.failure !== 'object' || chunk.reason.failure === null
          || typeof chunk.reason.failure.message !== 'string'
          || typeof chunk.reason.failure.code !== 'string')) {
        throw new TypeError('finish failure is invalid')
      }
      return
    default:
      throw new TypeError(`unknown chunk type '${String((chunk as { type?: unknown }).type)}'`)
  }
}

function validateContentBlock(root: ContentBlock, maxNodes: number): void {
  const pending: unknown[] = [root]
  let nodes = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (!record(value) || typeof value.type !== 'string' || value.type.length === 0) {
      throw new TypeError('content block must be an object with a non-empty type')
    }
    nodes++
    if (nodes > maxNodes) throw new TypeError(`content block tree exceeds ${maxNodes} nodes`)
    switch (value.type) {
      case 'text':
        if (typeof value.text !== 'string') throw new TypeError('text block text must be a string')
        if (value.phase !== undefined && value.phase !== 'commentary' && value.phase !== 'final-answer') {
          throw new TypeError('text block phase is invalid')
        }
        break
      case 'reasoning':
        if (typeof value.text !== 'string') throw new TypeError('reasoning block text must be a string')
        break
      case 'image':
        if (!record(value.source) || typeof value.source.kind !== 'string') {
          throw new TypeError('image block source is invalid')
        }
        if (value.source.kind === 'base64') {
          if (typeof value.source.data !== 'string' || typeof value.source.mediaType !== 'string') {
            throw new TypeError('base64 image source is invalid')
          }
        } else if (value.source.kind === 'url') {
          if (typeof value.source.url !== 'string') throw new TypeError('URL image source is invalid')
        } else if (value.source.kind === 'file') {
          if (typeof value.source.fileId !== 'string') throw new TypeError('file image source is invalid')
        } else {
          throw new TypeError('image source kind is invalid')
        }
        break
      case 'tool-call':
        if (typeof value.id !== 'string' || value.id.length === 0
          || typeof value.name !== 'string' || value.name.length === 0
          || typeof value.arguments !== 'string') {
          throw new TypeError('tool-call block fields are invalid')
        }
        break
      case 'tool-result':
        if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0
          || !Array.isArray(value.content)
          || (value.isError !== undefined && typeof value.isError !== 'boolean')) {
          throw new TypeError('tool-result block fields are invalid')
        }
        for (let index = value.content.length - 1; index >= 0; index--) pending.push(value.content[index])
        break
      case 'native-tool-call':
        if (typeof value.id !== 'string' || value.id.length === 0
          || typeof value.name !== 'string' || value.name.length === 0
          || (value.status !== undefined && typeof value.status !== 'string')
          || !Array.isArray(value.content)) {
          throw new TypeError('native-tool-call block fields are invalid')
        }
        for (let index = value.content.length - 1; index >= 0; index--) pending.push(value.content[index])
        break
      default:
        // ContentBlockMap is declaration-merge extensible. The core can only
        // validate the tags it owns; extension blocks remain adapter-defined.
        break
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validateUsageCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`usage ${field} must be a non-negative safe integer`)
}
class StreamAbortError extends Error {
  constructor(override readonly cause: unknown) {
    super('model stream was aborted')
    this.name = 'StreamAbortError'
  }
}
async function nextWithAbort<T>(
  pending: Promise<IteratorResult<T>>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new StreamAbortError(signal.reason)
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new StreamAbortError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
async function closeIterator<T>(iterator: AsyncIterator<T>, timeoutMs: number): Promise<boolean> {
  const close = iterator.return?.bind(iterator)
  if (close === undefined) return true
  const closing = Promise.resolve().then(async () => { await close() })
  return await waitForSettlement(closing, timeoutMs)
}
async function runOptionalHook<TArgs extends readonly unknown[], TResult>(
  hook: ((...args: TArgs) => TResult | Promise<TResult>) | undefined,
  args: TArgs,
  options: RunTurnOptions,
  signal: AbortSignal,
  name: string,
): Promise<Awaited<TResult> | undefined> {
  if (hook === undefined) return undefined
  const pending = Promise.resolve().then(() => hook(...args))
  return await runHook(pending, options, signal, name)
}
async function runHook<T>(
  pending: Promise<T>,
  options: RunTurnOptions,
  signal: AbortSignal,
  name: string,
): Promise<T> {
  const timeoutMs = positiveSafeInteger(options.hookTimeoutMs ?? 10 * 60_000, 'hookTimeoutMs')
  const teardownTimeoutMs = positiveSafeInteger(
    options.hookTeardownTimeoutMs ?? 30_000,
    'hookTeardownTimeoutMs',
  )
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  try {
    return await nextValueWithAbort(pending, combined)
  } catch (error: unknown) {
    if (!combined.aborted) throw error
    const settled = await waitForSettlement(pending, teardownTimeoutMs)
    if (!settled) {
      throw codedRuntimeError(
        `turn hook '${name}' ignored cancellation for more than ${teardownTimeoutMs}ms`,
        'HOOK_TEARDOWN_TIMEOUT',
        error,
      )
    }
    if (deadline.aborted && !signal.aborted) {
      throw codedRuntimeError(`turn hook '${name}' exceeded ${timeoutMs}ms`, 'HOOK_TIMEOUT', error)
    }
    throw error
  }
}
async function nextValueWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new StreamAbortError(signal.reason)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new StreamAbortError(signal.reason))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
function codedRuntimeError(message: string, code: string, cause: unknown): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string }
  error.code = code
  return error
}
function repeatKey(call: ToolCallRequest): string {
  // This is a heuristic guard, not a semantic JSON comparator. Keeping the
  // provider's bounded raw arguments avoids recursively normalizing a deeply
  // nested payload and turning repeat detection into a stack-exhaustion vector.
  return `${call.toolName}:${jsonTextFingerprint(call.rawArguments.trim())}`
}
function toolActionPattern(calls: readonly ToolCallRequest[]): string {
  return calls.map(call => repeatKey(call)).join('|')
}
function repeatedSuffixCycle(
  steps: readonly string[],
  maxPeriod: number,
): { readonly period: number; readonly repetitions: number } | undefined {
  const maximum = Math.min(maxPeriod, Math.floor(steps.length / 2))
  let best: { readonly period: number; readonly repetitions: number } | undefined
  for (let period = 1; period <= maximum; period++) {
    let repetitions = 1
    while ((repetitions + 1) * period <= steps.length) {
      const rightStart = steps.length - period
      const leftStart = rightStart - repetitions * period
      let equal = true
      for (let offset = 0; offset < period; offset++) {
        if (steps[leftStart + offset] !== steps[rightStart + offset]) {
          equal = false
          break
        }
      }
      if (!equal) break
      repetitions++
    }
    if (repetitions >= 2 && (best === undefined || repetitions > best.repetitions)) {
      best = { period, repetitions }
    }
  }
  return best
}
function jsonTextFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  let length = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (!quoted && (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)) continue
    length++
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + length), 0x85ebca6b)
    if (quoted) {
      if (escaped) escaped = false
      else if (code === 0x5c) escaped = true
      else if (code === 0x22) quoted = false
    } else if (code === 0x22) quoted = true
  }
  return `${length.toString(36)}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}
function textOf(blocks: readonly ContentBlock[]): string {
  const text = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  const final = text.filter(block => block.phase === 'final-answer')
  if (final.length > 0) return final.map(block => block.text).join('')
  return text.filter(block => block.phase !== 'commentary').map(block => block.text).join('')
}
function zeroUsage(): TokenUsage { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
function addUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (next === undefined) return total
  return {
    inputTokens: saturatedAdd(total.inputTokens, next.inputTokens),
    outputTokens: saturatedAdd(total.outputTokens, next.outputTokens),
    totalTokens: saturatedAdd(
      total.totalTokens ?? 0,
      next.totalTokens ?? saturatedAdd(next.inputTokens, next.outputTokens),
    ),
    ...sumOptional(total.cacheReadTokens, next.cacheReadTokens, 'cacheReadTokens'),
    ...sumOptional(total.cacheWriteTokens, next.cacheWriteTokens, 'cacheWriteTokens'),
    ...sumOptional(total.reasoningTokens, next.reasoningTokens, 'reasoningTokens'),
  }
}
function sumOptional(a: number | undefined, b: number | undefined, key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens') {
  return a === undefined && b === undefined ? {} : { [key]: saturatedAdd(a ?? 0, b ?? 0) }
}
function saturatedAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}
function now(): string { return new Date().toISOString() }

function snapshotRunTurnOptions(options: RunTurnOptions): RunTurnOptions {
  const config = Object.freeze({
    provider: options.config.provider,
    model: options.config.model,
    ...(options.config.reasoningEffort === undefined ? {} : { reasoningEffort: options.config.reasoningEffort }),
    ...(options.config.temperature === undefined ? {} : { temperature: options.config.temperature }),
    ...(options.config.topP === undefined ? {} : { topP: options.config.topP }),
    ...(options.config.maxTokens === undefined ? {} : { maxTokens: options.config.maxTokens }),
    ...(options.config.stop === undefined ? {} : { stop: Object.freeze([...options.config.stop]) }),
  })
  return Object.freeze({
    ...options,
    config,
    ...(options.bounds === undefined ? {} : { bounds: Object.freeze({ ...options.bounds }) }),
    ...(options.nativeTools === undefined ? {} : { nativeTools: Object.freeze([...options.nativeTools]) }),
    ...(options.interceptors === undefined ? {} : { interceptors: Object.freeze([...options.interceptors]) }),
    ...(options.hooks === undefined ? {} : { hooks: Object.freeze({ ...options.hooks }) }),
    ...(options.trace === undefined ? {} : { trace: Object.freeze({ ...options.trace }) }),
  })
}
