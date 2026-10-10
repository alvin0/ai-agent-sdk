import { UNCHANGED_ANSWER_MARKER } from '../control-text.ts'
import { MODEL_ERROR_CODES, type ModelFailure } from '../../../errors/index.ts'
import type { ContentBlock, Message, ToolCallBlock } from '../../../message/index.ts'
import type { BlockAssembler, FinishReason } from '../../../stream/index.ts'
import type { RoundResult } from './types.ts'
import { messageOf, now } from './common.ts'
import { classifyTextPhases, dropDuplicateToolCalls, invalidHostToolCall, contentTiming,
  createAssistant, textOf } from './content.ts'
import type { ModelRoundContext, ModelStreamResult } from './model-round-types.ts'

function stripForcedCalls(
  blocks: readonly ContentBlock[], forcedFinal: boolean, finishKind: FinishReason['kind'], lastCall: number,
): ContentBlock[] | undefined {
  if (!forcedFinal || (finishKind !== 'tool-calls' && finishKind !== 'stop') || lastCall < 0) return undefined
  return blocks.flatMap((block, index): ContentBlock[] => {
    if (block.type === 'tool-call') return []
    if (block.type === 'text' && block.phase === undefined) {
      return [{ ...block, phase: index > lastCall ? 'final-answer' as const : 'commentary' as const }]
    }
    return [block]
  })
}

function resolveFinish(
  providerFinish: FinishReason, invalidCall: ModelFailure | undefined, stripped: boolean,
): FinishReason {
  if (providerFinish.kind === 'error' || providerFinish.kind === 'aborted') return providerFinish
  if (invalidCall !== undefined) return { kind: 'error', failure: invalidCall }
  return stripped ? { kind: 'stop' } : providerFinish
}

function finishStatus(finish: FinishReason): 'error' | 'aborted' | 'success' {
  if (finish.kind === 'error') return 'error'
  return finish.kind === 'aborted' ? 'aborted' : 'success'
}

export async function finishModelRound(context: ModelRoundContext, stream: ModelStreamResult): Promise<RoundResult> {
  const { options, emit, trace, turn, step, finalOutput, afterToolCallIds } = context
  const { assembler } = stream
  const assembly = classifyAssembly(context, assembler)
  const invalidCall = invalidRoundCall(context, assembly)
  const blocks = retainedContent(assembly.classified, invalidCall)
  // A broken stream is the real failure; a malformed call must not hide it.
  const finish = resolveFinish(assembly.providerFinish, invalidCall, assembly.strippedForcedCalls)
  const message = blocks.length === 0 ? undefined
    : createAssistant(options, blocks, assembly.retainedPrefix ? undefined : assembler.replayState)
  const calls = callRequests(message)
  const timing = contentTiming(calls.length > 0, afterToolCallIds.length > 0)
  await emitTextEnds(context, assembly.canonicalTexts, { blocks, finish })
  await emitRoundEnd(context, assembler, message, { calls, finish })
  if (calls.length === 0 || finalOutput) await emit({ type: 'step-end', turn, step, trace })
  return roundResult(context, stream, message, { calls, finish, timing, dropped: assembly.dropped })
}

function readAssembly(assembler: BlockAssembler) {
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
  return { providerFinish, retainedPrefix, rawBlocks }
}

function hintTextPhases(assembler: BlockAssembler, assembly: ReturnType<typeof readAssembly>) {
  const { retainedPrefix, rawBlocks } = assembly
  // Interrupted/truncated assembly drops unfinished calls, but the text that
  // introduced those calls is still process narration, not a final answer.
  const canonicalTexts = assembler.textBlocks()
    .filter(({ block }) => !retainedPrefix || block.text.trim() !== '')
  let textPosition = 0
  const phaseHinted = rawBlocks.map(block => {
    if (block.type !== 'text') return block
    const canonical = canonicalTexts[textPosition++]
    // Safe-prefix recovery removes native calls too. Retain their position so
    // search narration cannot become an answer merely because a call was removed.
    return block.phase === undefined && canonical?.beforeNativeCall
      ? { ...block, phase: 'commentary' as const } : block
  })
  return { canonicalTexts, phaseHinted }
}

function classifyAssembly(context: ModelRoundContext, assembler: BlockAssembler) {
  const { options, forcedFinal, phase } = context
  const assembly = readAssembly(assembler)
  const { providerFinish } = assembly
  const hinted = hintTextPhases(assembler, assembly)
  const { phaseHinted } = hinted
  // A forced answer that also reaches for a tool it cannot use still answered,
  // when the stream itself ended normally: drop the call and keep the answer
  // rather than failing the run. Only text the provider labelled as the answer,
  // or unlabelled text written after the last call, counts: unlabelled text
  // before a call is its preamble ("let me search…"), and provider-labelled
  // commentary stays commentary. A round with no answer text keeps the call and
  // is reported as invalid below.
  const lastCall = phaseHinted.findLastIndex(block => block.type === 'tool-call')
  const strippedCandidate = stripForcedCalls(phaseHinted, forcedFinal, providerFinish.kind, lastCall)
  const strippedForcedCalls = strippedCandidate !== undefined
    && strippedCandidate.some(block => block.type === 'text' && block.phase !== 'commentary'
      && block.text.trim() !== '')
  const classifiedRaw = strippedForcedCalls
    ? strippedCandidate!
    : classifyTextPhases(phaseHinted, phase === 'process', assembler.hasToolCalls)
  // A repeated id costs the model that one call, not its whole turn.
  const deduped = dropDuplicateToolCalls(classifiedRaw, options.history)
  const classified = deduped.blocks
  return { ...assembly, ...hinted, classified, strippedForcedCalls, dropped: deduped.dropped }
}

function invalidRoundCall(context: ModelRoundContext, assembly: ReturnType<typeof classifyAssembly>) {
  const { options, finalOutput } = context
  const { classified } = assembly
  const structuredFailure = structuredOutputFailure(context, assembly)
  const disabledCall = finalOutput && classified.some(block => block.type === 'tool-call')
    ? { message: 'model emitted a host tool call during the final output phase', code: 'INVALID_TOOL_CALL' }
    : undefined
  return disabledCall ?? structuredFailure ?? invalidHostToolCall(classified, options.history)
}

function structuredOutputFailure(context: ModelRoundContext, assembly: ReturnType<typeof classifyAssembly>) {
  const { options, finalOutput } = context
  const { providerFinish, strippedForcedCalls, classified } = assembly
  return finalOutput
    && options.outputFormat?.type === 'json_schema'
    && (providerFinish.kind === 'stop' || strippedForcedCalls)
    && !isJsonText(textOf(classified), options.validateOutput)
    ? {
      message: 'model returned invalid JSON or failed the structured output validator',
      code: MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    }
    : undefined
}

function retainedContent(
  classified: readonly ContentBlock[], invalidCall: ModelFailure | undefined,
): readonly ContentBlock[] {
  const rawContent = invalidCall === undefined
    ? classified
    : classified.filter(block => block.type !== 'tool-call')
  // A control reply cannot confirm an answer while dispatching more work.
  // Strip it before persistence so tool-call identities are recorded only once.
  const blocks = rawContent.some(block => block.type === 'tool-call')
    ? rawContent.map(block => block.type === 'text'
      ? { ...block, text: block.text.replaceAll(UNCHANGED_ANSWER_MARKER, '') } : block)
    : rawContent
  return blocks
}

function callRequests(message: Message | undefined) {
  return message?.content.filter((block): block is ToolCallBlock => block.type === 'tool-call')
    .map(block => ({ callId: block.id, toolName: block.name, rawArguments: block.arguments })) ?? []
}

async function emitTextEnds(context: ModelRoundContext,
  canonicalTexts: ReturnType<BlockAssembler['textBlocks']>,
  result: { readonly blocks: readonly ContentBlock[]; readonly finish: FinishReason },
): Promise<void> {
  const { emit, trace } = context
  const { blocks, finish } = result
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
}

async function emitRoundEnd(context: ModelRoundContext, assembler: BlockAssembler, message: Message | undefined,
  result: { readonly calls: ReturnType<typeof callRequests>; readonly finish: FinishReason },
): Promise<void> {
  const { emit, trace } = context
  const { calls, finish } = result
  await emit({
    type: 'span-end', trace, at: now(),
    status: finishStatus(finish),
    output: message === undefined ? undefined : {
      text: textOf(message.content),
      commentary: message.content.flatMap(block => block.type === 'text'
        && block.phase === 'commentary' ? [block.text] : []),
      reasoning: message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []),
      toolCalls: calls.length,
    },
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    ...finish.kind === 'error' || finish.kind === 'aborted'
      ? { error: { type: 'ModelError', message: finish.failure.message, code: finish.failure.code } }
      : {},
  })
}

function roundResult(context: ModelRoundContext, stream: ModelStreamResult, message: Message | undefined,
  result: { readonly calls: ReturnType<typeof callRequests>; readonly finish: FinishReason
    readonly timing: RoundResult['timing']; readonly dropped: NonNullable<RoundResult['droppedDuplicateCalls']> },
): RoundResult {
  const { trace, afterToolCallIds } = context
  const { assembler, modelCallReport, usageRequired, usageUnavailable } = stream
  const { calls, finish, timing } = result
  return {
    trace, ...message === undefined ? {} : { message }, finish,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    ...modelCallReport === undefined ? {} : { report: modelCallReport },
    ...usageRequired ? { usageRequired: true as const } : {},
    ...usageUnavailable ? { usageUnavailable: true as const } : {},
    calls, afterToolCallIds, timing,
    ...result.dropped.length === 0 ? {} : { droppedDuplicateCalls: result.dropped },
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
