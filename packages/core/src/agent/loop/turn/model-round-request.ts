import type { GenerateOptions } from '../../../contract/index.ts'
import type { ModelFailure } from '../../../errors/index.ts'
import type { Message } from '../../../message/index.ts'
import { normalizeToolPairing } from '../../history/normalize.ts'
import { createSpanId } from '../../trace/trace.ts'
import type { RunTurnOptions, RoundResult } from './types.ts'
import { messageOf, now } from './common.ts'
import { runOptionalHook } from './hooks.ts'
import { stepProjectionSources } from './step-projection.ts'
import { observeModelRequestBoundary } from './model-request-boundary.ts'
import { accountingUsageStop } from './usage-stop.ts'
import { recentToolResultIds, contentTiming, systemText, textOf } from './content.ts'
import type { ModelRoundContext, ModelRoundInput } from './model-round-types.ts'

/** How much of one message the trace keeps. */
const PREVIEW_CHARS = 600

/** How many trailing messages the trace keeps. */
const PREVIEW_MESSAGES = 8

function resolveOutputFormat(options: RunTurnOptions, finalOutput: boolean): GenerateOptions['outputFormat'] {
  if (!finalOutput && options.outputFormat?.type === 'json_schema') return { type: 'text' as const }
  return options.outputFormat
}

function requestToolChoice(
  options: RunTurnOptions, finalOutput: boolean, toolCount: number,
): Record<string, unknown> {
  if (finalOutput && toolCount > 0) return { toolChoice: 'none' }
  return options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }
}

function clip(text: string): string {
  const flattened = text.replace(/\s+/gu, ' ').trim()
  return flattened.length > PREVIEW_CHARS ? `${flattened.slice(0, PREVIEW_CHARS)}…` : flattened
}

/** One message as a line: who spoke, and what the model could read of it. */
function previewMessage(message: Message): Record<string, unknown> {
  const parts: string[] = []
  const calls: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'reasoning') parts.push(block.text)
    else if (block.type === 'tool-call') calls.push(`${block.name}(${clip(block.arguments)})`)
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
    else parts.push(`[${block.type}]`)
  }
  return {
    role: message.role,
    producer: message.source.kind,
    ...parts.length === 0 ? {} : { text: clip(parts.join(' ')) },
    ...calls.length === 0 ? {} : { toolCalls: calls },
  }
}

/**
 * What this round sent the model, in a form a person can read.
 *
 * A summary, not a copy: the request can be the whole conversation plus every
 * tool schema, and a trace that stored it verbatim would be larger than the
 * work it describes. What survives is the part that explains the round — which
 * tools were on offer, how long the context was, and the tail of the
 * conversation the model was actually answering, each message clipped.
 * @param request - The request about to be dispatched.
 * @returns The summary for the span.
 */
function requestSummary(request: GenerateOptions): Record<string, unknown> {
  const messages = request.messages ?? []
  const dropped = Math.max(0, messages.length - PREVIEW_MESSAGES)
  return {
    messageCount: messages.length,
    // The identity of the request, for a host that records the provider call
    // separately and has to say WHICH round each recording belongs to. Message
    // ids are stable across every representation boundary, so the last one plus
    // the count names one round of one agent without ambiguity.
    ...messages.at(-1) === undefined ? {} : { lastMessageId: messages.at(-1)?.id },
    ...request.system === undefined ? {} : { system: clip(request.system) },
    ...request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: request.tools.map(tool => tool.name) },
    ...request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice },
    ...dropped === 0 ? {} : { earlierMessagesOmitted: dropped },
    messages: messages.slice(-PREVIEW_MESSAGES).map(previewMessage),
  }
}

export function createRoundContext(input: ModelRoundInput): ModelRoundContext {
  const { options, root, step, phase } = input
  const forcedFinal = phase === 'forced-final'
  return {
    ...input,
    position: input.position ?? { workStep: step, finalizing: false },
    forcedFinal, finalOutput: phase === 'final' || forcedFinal,
    trace: { traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId },
    initialMessages: normalizeToolPairing(options.history.messages()),
    afterToolCallIds: recentToolResultIds(options.history),
    generation: options.history.generation(), entries: options.history.entries().length,
  }
}

function stopped(context: ModelRoundContext): RoundResult | undefined {
  const { options, signal, trace, afterToolCallIds } = context
  const stop = accountingUsageStop(options.accounting)
  if (stop === undefined && !signal.aborted) return undefined
  return {
    trace, finish: signal.aborted
      ? { kind: 'aborted', failure: { code: 'ABORTED', message: messageOf(signal.reason) } }
      : { kind: 'stop' },
    calls: [], afterToolCallIds, timing: contentTiming(false, afterToolCallIds.length > 0),
    ...(stop?.kind === 'error' ? { usageRequired: true } : {}),
    ...(stop?.kind === 'usage-unavailable' ? { usageUnavailable: true } : {}),
  }
}

function rejectedRound(context: ModelRoundContext, failure: ModelFailure): RoundResult {
  const { trace, afterToolCallIds } = context
  return { trace, finish: { kind: 'error', failure }, calls: [], afterToolCallIds,
    timing: contentTiming(false, afterToolCallIds.length > 0) }
}

export async function prepareModelRequest(context: ModelRoundContext): Promise<
  { readonly result: RoundResult } | { readonly request: GenerateOptions }
> {
  const { options, signal, turn, step, phase, position, emitMaintenance } = context
  const beforeMaintenance = stopped(context)
  if (beforeMaintenance !== undefined) return { result: beforeMaintenance }
  const decision = await runOptionalHook(options.hooks?.beforeStep, [{
    turn, step, workStep: position.workStep, phase, ...position.finalizing ? { finalizing: true as const } : {},
    messages: context.initialMessages, snapshot: options.history.snapshot(), signal,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    emit: emitMaintenance,
  }], options, { signal, name: 'beforeStep' })
  const afterMaintenance = stopped(context)
  if (afterMaintenance !== undefined) return { result: afterMaintenance }
  if (decision?.kind === 'reject') {
    const failure: ModelFailure = { message: decision.reason, code: 'STEP_REJECTED' }
    return { result: rejectedRound(context, failure) }
  }
  const messages = projectDecision(context, decision)
  const requestBase = createRequest(context, messages)
  const checkpointFailure = await checkpointRequest(context, requestBase)
  if (checkpointFailure !== undefined) return { result: checkpointFailure }
  const beforeDispatch = stopped(context)
  if (beforeDispatch !== undefined) {
    observeModelRequestBoundary(options.history, false)
    return { result: beforeDispatch }
  }
  return { request: requestBase }
}

type StepDecision = Exclude<
  Awaited<ReturnType<NonNullable<NonNullable<RunTurnOptions['hooks']>['beforeStep']>>>, { readonly kind: 'reject' }
>

function projectDecision(context: ModelRoundContext, decision: StepDecision | undefined): readonly Message[] {
  const { options, generation, entries, initialMessages } = context
  let messages = context.initialMessages
  // Hooks may append live steering as well as replacing compacted history.
  // Refresh for either mutation so new user input stays at the chronological
  // tail instead of needing to be prepended ahead of older history.
  if (options.history.generation() !== generation
    || options.history.entries().length !== entries) {
    messages = normalizeToolPairing(options.history.messages())
  }
  if (decision?.messages !== undefined) {
    const originalIds = stepProjectionSources(decision) ?? new Set(initialMessages.map(message => message.id))
    const projectedIds = new Set(decision.messages.map(message => message.id))
    const introduced = messages.filter(message => !originalIds.has(message.id) && !projectedIds.has(message.id))
    const currentIds = new Set(messages.map(message => message.id))
    const replaced = [...originalIds].some(id => !currentIds.has(id))
    // A hook can await external I/O while live steering or replacement arrives.
    // Replacements invalidate a stale projection; append-only steering stays at the tail.
    const projectedById = new Map(decision.messages.map(message => [message.id, message]))
    messages = normalizeToolPairing(replaced
      ? [...decision.messages.filter(message => !originalIds.has(message.id) && !currentIds.has(message.id)
        && message.source.kind === 'app'),
        ...messages.flatMap(message => {
          const projected = projectedById.get(message.id)
          if (projected !== undefined) return [projected]
          return originalIds.has(message.id) ? [] : [message]
        })]
      : [...decision.messages, ...introduced])
  }
  if (decision?.prepend !== undefined) messages = Object.freeze([...decision.prepend, ...messages])
  return messages
}

function createRequest(context: ModelRoundContext, messages: readonly Message[]): GenerateOptions {
  const { options, forcedFinal, finalOutput } = context
  const system = systemText(options, forcedFinal)
  const availableTools = [
    ...options.tools?.schemas() ?? [],
    ...options.nativeTools ?? [],
  ]
  const tools = availableTools
  const outputFormat = resolveOutputFormat(options, finalOutput)
  return {
    ...options.config,
    messages,
    ...system.length === 0 ? {} : { system },
    ...tools.length === 0 ? {} : { tools },
    ...requestToolChoice(options, finalOutput, tools.length),
    ...options.imagePolicy === undefined ? {} : { imagePolicy: options.imagePolicy },
    ...options.documentPolicy === undefined ? {} : { documentPolicy: options.documentPolicy },
    ...outputFormat === undefined ? {} : { outputFormat },
  }
}

async function checkpointRequest(
  context: ModelRoundContext, requestBase: GenerateOptions,
): Promise<RoundResult | undefined> {
  const { options, signal } = context
  const request: GenerateOptions = { ...requestBase, signal }
  observeModelRequestBoundary(options.history, true)
  try {
    await runOptionalHook(options.hooks?.checkpoint, [{
      kind: 'before-model-request', request,
      snapshot: options.history.snapshot(), signal,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }], options, { signal, name: 'checkpoint' })
  } catch (error: unknown) {
    // No output will be recorded for this request. Release queued input before
    // recovery hooks or the retry's beforeStep can read or inject into history.
    observeModelRequestBoundary(options.history, false)
    const failure: ModelFailure = { message: `history checkpoint failed: ${messageOf(error)}`,
      code: 'CHECKPOINT_FAILED' }
    return rejectedRound(context, failure)
  }
  return undefined
}

export async function emitRoundStart(context: ModelRoundContext, requestBase: GenerateOptions): Promise<void> {
  const { options, emit, trace, turn, step, forcedFinal, phase } = context
  await emit({ type: 'span-start', trace, at: now(), name: `chat ${options.config.model}`, kind: 'chat', attributes: {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': options.config.model,
    // The effort is part of WHICH call this was: the same model at minimal and
    // at high is two different requests, priced and paced differently, and a
    // trace that omits it cannot explain either. Absent when the route has no
    // effort ladder, rather than reported as a default nobody chose.
    ...options.config.reasoningEffort === undefined
      ? {}
      : { 'gen_ai.request.reasoning_effort': options.config.reasoningEffort },
    turn, step, forcedFinal, phase,
  }, input: requestSummary(requestBase) })
  await emit({ type: 'step-start', turn, step, trace, ...forcedFinal ? { forcedFinal: true as const } : {} })
}
