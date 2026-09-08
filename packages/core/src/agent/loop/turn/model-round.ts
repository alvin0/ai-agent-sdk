import type { GenerateOptions } from '../../../contract/index.ts'
import { MODEL_ERROR_CODES, type ModelFailure } from '../../../errors/index.ts'
import type { ContentBlock, ToolCallBlock } from '../../../message/index.ts'
import { BlockAssembler } from '../../../stream/index.ts'
import type { FinishReason } from '../../../stream/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import { normalizeToolPairing } from '../../history/normalize.ts'
import { createSpanId, type TraceRef } from '../../trace/trace.ts'
import type { AgentEvent, AgentMaintenanceEvent } from '../types.ts'
import { type ModelRoundPhase, type RunTurnOptions, type RoundResult } from './types.ts'
import { positiveFinite, positiveSafeInteger } from './config.ts'
import { serializedBytes, modelFailureFinish, modelAbortedFinish, messageOf, now } from './common.ts'
import { validateStreamChunk } from './validation.ts'
import { StreamAbortError, nextWithAbort, closeIterator } from './cancellation.ts'
import { runOptionalHook } from './hooks.ts'
import { accountingUsageStop } from './usage-stop.ts'
import {
  classifyTextPhases, dropDuplicateToolCalls, invalidHostToolCall, contentTiming,
  recentToolResultIds, systemText,
  createAssistant, textOf,
} from './content.ts'

export async function modelRound(
  options: RunTurnOptions,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
  emitMaintenance: (event: AgentMaintenanceEvent) => Promise<void>,
  root: TraceRef,
  turn: number,
  step: number,
  phase: ModelRoundPhase,
): Promise<RoundResult> {
  const forcedFinal = phase === 'forced-final'
  const finalOutput = phase === 'final' || forcedFinal
  const trace: TraceRef = { traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId }
  let messages = normalizeToolPairing(options.history.messages())
  const afterToolCallIds = recentToolResultIds(options.history)
  const generation = options.history.generation()
  const entries = options.history.entries().length
  const stopped = (): RoundResult | undefined => {
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
  const beforeMaintenance = stopped()
  if (beforeMaintenance !== undefined) return beforeMaintenance
  const decision = await runOptionalHook(options.hooks?.beforeStep, [{
    turn, step, messages, snapshot: options.history.snapshot(), signal,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    emit: emitMaintenance,
  }], options, signal, 'beforeStep')
  const afterMaintenance = stopped()
  if (afterMaintenance !== undefined) return afterMaintenance
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
  const availableTools = [
    ...options.tools?.schemas() ?? [],
    ...options.nativeTools ?? [],
  ]
  const tools = availableTools
  const outputFormat = !finalOutput && options.outputFormat?.type === 'json_schema'
    ? { type: 'text' as const }
    : options.outputFormat
  const requestBase: GenerateOptions = {
    ...options.config,
    messages,
    ...system.length === 0 ? {} : { system },
    ...tools.length === 0 ? {} : { tools },
    ...finalOutput && tools.length > 0
      ? { toolChoice: 'none' as const }
      : options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice },
    ...options.imagePolicy === undefined ? {} : { imagePolicy: options.imagePolicy },
    ...outputFormat === undefined ? {} : { outputFormat },
  }
  const checkpointRequest: GenerateOptions = { ...requestBase, signal }
  try {
    await runOptionalHook(options.hooks?.checkpoint, [{
      kind: 'before-model-request', request: checkpointRequest,
      snapshot: options.history.snapshot(), signal,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }], options, signal, 'checkpoint')
  } catch (error: unknown) {
    const failure: ModelFailure = { message: `history checkpoint failed: ${messageOf(error)}`, code: 'CHECKPOINT_FAILED' }
    return {
      trace, finish: { kind: 'error', failure }, calls: [], afterToolCallIds,
      timing: contentTiming(false, afterToolCallIds.length > 0),
    }
  }
  const beforeDispatch = stopped()
  if (beforeDispatch !== undefined) return beforeDispatch
  await emit({ type: 'span-start', trace, at: now(), name: `chat ${options.config.model}`, kind: 'chat', attributes: {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': options.config.model,
    turn, step, forcedFinal, phase,
  } })
  await emit({ type: 'step-start', turn, step, trace, ...forcedFinal ? { forcedFinal: true as const } : {} })
  const assembler = new BlockAssembler()
  const closedBlockIndexes = new Set<number>()
  const modelTimeoutMs = positiveFinite(options.modelTimeoutMs ?? 10 * 60_000, 'modelTimeoutMs')
  const maxRequestBytes = positiveSafeInteger(options.maxModelRequestBytes ?? 32 * 1024 * 1024, 'maxModelRequestBytes')
  const maxResponseBytes = positiveSafeInteger(options.maxModelResponseBytes ?? 32 * 1024 * 1024, 'maxModelResponseBytes')
  const maxStreamEvents = positiveSafeInteger(options.maxModelStreamEvents ?? 100_000, 'maxModelStreamEvents')
  const teardownTimeoutMs = positiveFinite(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  let modelCallReport: ModelCallReport | undefined
  let usageRequired = false
  let usageUnavailable = false
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
    const handle = options.registry.stream(
      { ...requestBase, signal: roundSignal },
      options.accounting?.modelInvocation,
    )
    const iterator = handle[Symbol.asyncIterator]()
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
        // The assembler ignores deltas after the first close. The visible
        // stream must do the same or UI text can disagree with stored history.
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
          && closedBlockIndexes.has(chunk.index)) continue
        if (chunk.type === 'block-end') closedBlockIndexes.add(chunk.index)
        if (chunk.type === 'finish') sawFinish = true
        if (chunk.type === 'text-delta') await emit({
          type: 'text-delta', index: chunk.index, text: chunk.text,
          phase: phase === 'process' ? 'commentary' : chunk.phase ?? 'unknown', trace,
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
    const report = await handle.report
    const decision = options.accounting === undefined
      ? undefined
      : await options.accounting.recordModelCall(report, { ...requestBase, signal })
    modelCallReport = decision?.report ?? report
    usageRequired = decision?.usageRequired ?? false
    usageUnavailable = decision?.usageUnavailable ?? false
  }
  let providerFinish = assembler.finish
  let retainedPrefix = providerFinish.kind === 'aborted'
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
    // A broken extension must not discard text already delivered to the user.
    // This prefix deliberately excludes tools and unassembled extension data.
    retainedPrefix = true
    rawBlocks = assembler.interruptedBlocks()
  }
  // Interrupted/truncated assembly drops unfinished calls, but the text that
  // introduced those calls is still process narration, not a final answer.
  const canonicalTexts = assembler.textBlocks()
    .filter(({ block }) => !retainedPrefix || block.text.trim() !== '')
  let textPosition = 0
  const classifiedRaw = classifyTextPhases(rawBlocks.map(block => {
    if (block.type !== 'text') return block
    const canonical = canonicalTexts[textPosition++]
    // Safe-prefix recovery removes native calls too. Retain their position so
    // search narration cannot become an answer merely because a call was removed.
    return block.phase === undefined && canonical?.beforeNativeCall
      ? { ...block, phase: 'commentary' as const } : block
  }), phase === 'process', assembler.hasToolCalls)
  // A repeated id costs the model that one call, not its whole turn.
  const deduped = dropDuplicateToolCalls(classifiedRaw, options.history)
  const classified = deduped.blocks
  const structuredOutputFailure = finalOutput
    && options.outputFormat?.type === 'json_schema'
    && providerFinish.kind === 'stop'
    && !isJsonText(textOf(classified), options.validateOutput)
    ? {
      message: 'model returned invalid JSON or failed the structured output validator',
      code: MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    }
    : undefined
  const disabledCall = finalOutput && classified.some(block => block.type === 'tool-call')
    ? { message: 'model emitted a host tool call during the final output phase', code: 'INVALID_TOOL_CALL' }
    : undefined
  const invalidCall = disabledCall
    ?? structuredOutputFailure
    ?? invalidHostToolCall(classified, options.history)
  const blocks = invalidCall === undefined
    ? classified
    : classified.filter(block => block.type !== 'tool-call')
  const finish: FinishReason = invalidCall === undefined
    ? providerFinish
    : { kind: 'error', failure: invalidCall }
  const message = blocks.length === 0 && (finish.kind === 'error' || finish.kind === 'aborted')
    ? undefined
    : createAssistant(options, blocks, retainedPrefix ? undefined : assembler.replayState)
  const calls = message?.content
    .filter((block): block is ToolCallBlock => block.type === 'tool-call')
    .map(block => ({ callId: block.id, toolName: block.name, rawArguments: block.arguments })) ?? []
  const timing = contentTiming(calls.length > 0, afterToolCallIds.length > 0)
  // Deltas may have no phase, or block-end may correct it. Publish the
  // canonical snapshot before consumers close this step, including providers
  // that only emit block-end. Keep provider indexes (which may be sparse).
  if (blocks.some(block => block.type === 'text')) {
    const indexes = canonicalTexts.map(({ index }) => index)
    const incomplete = finish.kind === 'error' || finish.kind === 'aborted' || finish.kind === 'max-tokens'
    let position = 0
    for (const block of blocks) {
      if (block.type !== 'text') continue
      const index = indexes[position++]
      if (index !== undefined) await emit({
        type: 'text-end', index, text: block.text,
        phase: block.phase ?? 'final-answer', trace,
        ...incomplete ? { incomplete: true as const } : {},
      })
    }
  }
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
  if (calls.length === 0 || finalOutput) await emit({ type: 'step-end', turn, step, trace })
  return {
    trace, ...message === undefined ? {} : { message }, finish,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    ...modelCallReport === undefined ? {} : { report: modelCallReport },
    ...usageRequired ? { usageRequired: true as const } : {},
    ...usageUnavailable ? { usageUnavailable: true as const } : {},
    calls, afterToolCallIds, timing,
    ...deduped.dropped.length === 0 ? {} : { droppedDuplicateCalls: deduped.dropped },
  }
}

function isJsonText(value: string, validate?: (value: unknown) => void): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    validate?.(parsed)
    return true
  } catch {
    return false
  }
}
