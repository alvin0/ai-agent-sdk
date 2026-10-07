import type { GenerateOptions, ModelToolSchema, ResolvedModelInfo } from '../../contract/index.ts'
import { createUserMessage, type Message } from '../../message/index.ts'
import { ReasoningEffortId } from '../../primitives/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { BlockAssembler, type StreamChunk, type TokenUsage } from '../../stream/index.ts'
import type { ModelCallHandle } from '../../observation/report.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import { compactionAccounting } from './accounting-binding.ts'
import type { ContextCompactorOptions } from './compaction.ts'
import { COMPACTION_INSTRUCTION, sanitizeForSummary, type CharacterBudget } from './compaction-content.ts'
import { assertUsageAdmission, codedError, raceWithSignal, serializedBytes } from './compaction-errors.ts'

export class CompactionSummarizer {
  private readonly input: ContextCompactorOptions
  private readonly owner: object

  constructor(input: ContextCompactorOptions, owner: object) {
    this.input = input
    this.owner = owner
  }

  async summarize(
    messages: readonly Message[],
    system: string,
    tools: readonly ModelToolSchema[],
    signal: AbortSignal,
  ): Promise<{ summary: string; provider: string; model: string; usage?: TokenUsage }> {
    const prepared = await this.prepare(messages, system, tools, signal)
    const { provider, model, accounting, request, handle, assembler, policy } = prepared
    let failure = await this.collect(handle, assembler, signal, policy)
    failure = await this.recordAccounting({ handle, accounting, request, failure })
    if (failure !== undefined) throw failure
    return summaryResult(assembler, provider, model)
  }

  private async prepare(
    messages: readonly Message[],
    system: string,
    tools: readonly ModelToolSchema[],
    signal: AbortSignal,
  ) {
    const policy = this.input.policy
    const active = this.input.config()
    const provider = policy.summarizationProvider ?? active.provider
    const model = policy.summarizationModel ?? active.model
    const accounting = compactionAccounting(this.owner)
    assertUsageAdmission(accounting)
    const summaryInfo = await raceWithSignal(
      this.input.registry.resolveModelInfo(provider, model, signal),
      signal,
    )
    const maxSummaryTokens = summaryTokenLimit(policy, summaryInfo)
    const prepared = await raceWithSignal(this.input.registry.prepareCall({
      provider,
      model,
      ...(policy.summarizationEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(policy.summarizationEffort) }),
      maxTokens: maxSummaryTokens,
    }, signal, accounting?.modelInvocation), signal)
    // Compaction can encounter history written by an older runtime or a process
    // interrupted between a tool call and its result. Repair the replay just as
    // normal model requests do so a maintenance request cannot be provider-invalid.
    const characterBudget: CharacterBudget = { remaining: policy.maxSummaryRequestChars }
    const replay = normalizeToolPairing(messages)
      .map(message => sanitizeForSummary(message, policy.maxSummaryInputChars, characterBudget))
    const instruction = createUserMessage({
      source: { kind: 'app', producer: 'agent-compaction' },
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    })
    const assembler = new BlockAssembler()
    const request = {
      ...prepared.config,
      messages: [...replay, instruction],
      ...(system.length === 0 ? {} : { system }),
      ...(tools.length === 0 ? {} : { tools }),
      toolChoice: 'none',
      signal,
    } as const
    const { signal: _signal, ...serializableRequest } = request
    if (serializedBytes(serializableRequest) > policy.maxSummaryRequestBytes) {
      throw codedError(
        `compaction summary request exceeds the ${policy.maxSummaryRequestBytes}-byte limit`,
        'MODEL_REQUEST_TOO_LARGE',
      )
    }
    assertUsageAdmission(accounting)
    const handle = prepared.stream(request, accounting?.modelInvocation)
    return { provider, model, accounting, request, handle, assembler, policy }
  }

  private async collect(
    handle: ModelCallHandle, assembler: BlockAssembler, signal: AbortSignal,
    policy: ContextCompactorOptions['policy'],
  ): Promise<unknown> {
    const iterator = handle[Symbol.asyncIterator]()
    let exhausted = false
    let events = 0
    let responseBytes = 0
    let sawFinish = false
    let failure: unknown
    try {
      while (true) {
        const next = await raceWithSignal(iterator.next(), signal)
        if (next.done === true) {
          exhausted = true
          break
        }
        events++
        responseBytes += serializedBytes(next.value)
        if (events > policy.maxSummaryStreamEvents
          || responseBytes > policy.maxSummaryResponseBytes) {
          throw codedError('compaction summary response exceeded its resource limit', 'MODEL_RESPONSE_TOO_LARGE')
        }
        if (sawFinish) {
          throw codedError('compaction summarizer emitted data after its terminal finish chunk', 'INVALID_MODEL_STREAM')
        }
        assembler.push(next.value)
        if (next.value.type === 'finish') sawFinish = true
      }
    } catch (error: unknown) {
      failure = error
    } finally {
      if (!exhausted) failure = await this.close(iterator, failure, policy)
    }
    return failure
  }

  private async close(
    iterator: AsyncIterator<StreamChunk>, failure: unknown, policy: ContextCompactorOptions['policy'],
  ): Promise<unknown> {
    const close = iterator.return?.bind(iterator)
    if (close !== undefined) {
      try {
        const closing = Promise.resolve().then(async () => { await close() })
        if (!await waitForSettlement(closing, policy.teardownTimeoutMs)) failure = codedError(
          `compaction model stream ignored cancellation for more than ${policy.teardownTimeoutMs}ms`,
          'MODEL_TEARDOWN_TIMEOUT',
        )
      } catch (error: unknown) { failure ??= error }
    }
    return failure
  }

  private async recordAccounting(input: {
    handle: ModelCallHandle
    accounting: ReturnType<typeof compactionAccounting>
    request: GenerateOptions
    failure: unknown
  }): Promise<unknown> {
    const { handle, accounting, request } = input
    let { failure } = input
    try {
      const report = await handle.report
      const decision = await accounting?.recordModelCall(report, request)
      if (decision?.usageRequired === true) {
        failure ??= codedError('compaction model usage is required by the configured run policy', 'USAGE_REQUIRED')
      }
      if (decision?.usageUnavailable === true) {
        failure ??= codedError('compaction model usage is unavailable for the configured budget', 'USAGE_UNAVAILABLE')
      }
    } catch (error: unknown) { failure ??= error }
    return failure
  }
}

function summaryResult(assembler: BlockAssembler, provider: string, model: string) {
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure.message) as Error & { code?: string }
    error.code = finish.failure.code
    throw error
  }
  if (finish.kind === 'max-tokens') throw new Error('compaction summary was truncated at maxSummaryTokens')
  if (finish.kind === 'tool-calls') throw new Error('compaction summarizer attempted a tool call')
  const summary = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  if (summary.length === 0) throw new Error('compaction summarizer produced no text')
  return {
    summary, provider, model,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

function summaryTokenLimit(policy: ContextCompactorOptions['policy'], summaryInfo: ResolvedModelInfo): number {
  return Math.min(
    policy.maxSummaryTokens,
    summaryInfo.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
    summaryInfo.context === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, summaryInfo.context.contextWindow - 1),
  )
}
