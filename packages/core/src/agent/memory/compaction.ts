import { systemRandomId } from '../../platform/adapter.ts'
/** Context-pressure compaction inspired by Codex checkpoints and deepseek-harness surface replacement. */

import type { CallConfig } from '../../contract/index.ts'
import type { ModelToolSchema } from '../../contract/index.ts'
import type { ContentBlock, ToolCallBlock, ToolResultBlock } from '../../message/index.ts'
import { createMessage, createUserMessage, type Message } from '../../message/index.ts'
import { ReasoningEffortId } from '../../primitives/index.ts'
import type { ModelRegistry } from '../../runtime/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { BlockAssembler } from '../../stream/index.ts'
import type { TokenUsage } from '../../stream/index.ts'
import type { History } from '../history/history.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import type {
  AgentMaintenanceEvent, BeforeStepContext, CompactionBackoffReason, CompactionTrigger, RequestErrorContext,
} from '../loop/events.ts'
import type { AgentCompactionConfig } from './compaction-config.ts'
import { compactionAccounting } from './accounting-binding.ts'
import type { RunReport } from '../accounting/delivery-types.ts'
import { pruneToolResults, selectCompactablePrefix } from './surface-compaction.ts'
import { estimateContextTokens, estimateMessageTokens } from './token-estimator.ts'

export interface CompactionResult {
  readonly compactionId: string
  readonly trigger: CompactionTrigger
  readonly summary: string
  readonly shadowedSeqs: readonly number[]
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
  readonly thresholdTokens?: number
  readonly estimatedNonCompactableTokens: number
  readonly backoffReason?: CompactionBackoffReason
  readonly cooldownSteps?: number
  readonly provider: string
  readonly model: string
  readonly usage?: TokenUsage
  /** Additive runtime projection; absent on the preserved low-level compactor path. */
  readonly status?: 'completed'
  readonly report?: RunReport
}

export interface ContextCompactorOptions {
  readonly registry: ModelRegistry
  /**
   * The call configuration in force RIGHT NOW, not when the compactor was built.
   *
   * A supplier rather than a value because a run may target a different model
   * than the session it belongs to: the context window a checkpoint is budgeted
   * against, and the model a summary is written by, both have to follow that
   * override or compaction would reason about a window nobody is calling.
   */
  readonly config: () => CallConfig
  readonly history: () => History
  readonly system: () => string
  readonly pinnedMessages?: () => readonly Message[]
  readonly tools: () => readonly ModelToolSchema[]
  readonly policy: AgentCompactionConfig
}

interface ResolvedBudget {
  readonly thresholdTokens: number
  readonly retainTokens: number
}

interface CharacterBudget { remaining: number }

const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint of earlier conversation context. Treat it as established background, preserve the original objective and constraints, and continue directly from the messages that follow.'

const MIN_PRESSURE_SAVINGS_TOKENS = 256
const MIN_PRESSURE_SAVINGS_RATIO = 0.01
const PRESSURE_BACKOFF_STEPS = 4

export const COMPACTION_INSTRUCTION = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION for a long-running AI agent task.',
  'Condense the conversation above into a handoff that lets another model continue without forgetting the original purpose.',
  '',
  'Output exactly these Markdown sections, in order, using terse bullets. Write "(none)" for an empty section.',
  '## Primary Request and Intent',
  '## Progress and Completed Work',
  '## Decisions and Rationale',
  '## Constraints and User Preferences',
  '## Important Files, Symbols, and Evidence',
  '## Errors and Failed Approaches',
  '## Pending Work',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  'Preserve exact paths, identifiers, commands, error strings, numeric limits, and user corrections when they matter.',
  'Under Important Files, mark relevant files as inspected or modified and preserve the exact declarations or findings needed next.',
  'Under Current Work, record the last successful tool action, the latest verification result, and whether any edit is still partial.',
  'Under Next Step, name one direct edit or command. Do not recommend rereading an unchanged file whose relevant contents are already recorded.',
  'Do not reveal hidden chain-of-thought. Record only public progress, observed evidence, decisions, and actionable context.',
  'If an earlier <compacted-summary> exists, merge still-valid facts with newer information and drop stale facts.',
  'Output only the checkpoint. Do not call tools and do not acknowledge the compaction.',
].join('\n')

export class ContextCompactor {
  private readonly input: ContextCompactorOptions
  private active = false
  private overflowTurn = -1
  private overflowRetries = 0
  private recoveringOverflow = false
  /** Keyed by route + model + output reserve: an override changes all three. */
  private modelBudget: {
    readonly key: string
    readonly budget: { readonly contextWindow: number; readonly outputReserve: number } | null
  } | undefined
  private pressureCooldown = 0

  constructor(input: ContextCompactorOptions) {
    this.input = input
  }

  /** Fail-open pressure maintenance for a pre-step hook. */
  async beforeStep(context: BeforeStepContext): Promise<void> {
    if (!this.input.policy.auto || context.signal.aborted) return
    if (this.pressureCooldown > 0) {
      this.pressureCooldown--
      return
    }
    if (this.overflowTurn !== context.turn) {
      this.overflowTurn = context.turn
      this.overflowRetries = 0
    } else if (!this.recoveringOverflow) {
      this.overflowRetries = 0
    }
    this.recoveringOverflow = false
    try {
      let lastResult: CompactionResult | undefined
      for (let attempt = 0; attempt <= this.input.policy.compactionRetries; attempt++) {
        const result = await this.compactIfNeeded('pressure', context.signal, context.emit)
        if (result === null) break
        lastResult = result
        if (result.backoffReason !== undefined) {
          this.pressureCooldown = result.cooldownSteps ?? PRESSURE_BACKOFF_STEPS
          break
        }
      }
      if (lastResult !== undefined
        && lastResult.thresholdTokens !== undefined
        && lastResult.estimatedTokensAfter >= lastResult.thresholdTokens) {
        this.pressureCooldown = Math.max(
          this.pressureCooldown,
          PRESSURE_BACKOFF_STEPS,
        )
      }
    } catch {
      // Pressure maintenance is fail-open; the provider's canonical overflow
      // error still gets one forced recovery path below. Avoid retrying the same
      // broken maintenance request on every tool step and flooding logs/traces.
      // Mandatory usage decisions stay latched in the owning ledger and are
      // checked by modelRound after this hook, before any main dispatch.
      this.pressureCooldown = 2
    }
  }

  /** Compact and retry only when a provider confirmed context overflow. */
  async onRequestError(context: RequestErrorContext): Promise<'retry' | undefined> {
    if (context.failure.code !== 'CONTEXT_WINDOW_EXCEEDED' || context.signal.aborted) return undefined
    if (this.overflowTurn !== context.turn) {
      this.overflowTurn = context.turn
      this.overflowRetries = 0
    }
    if (this.overflowRetries >= this.input.policy.maxOverflowRetries) return undefined
    try {
      const result = await this.compactIfNeeded('context-overflow', context.signal, context.emit)
      if (result === null || context.signal.aborted) return undefined
      this.overflowRetries++
      this.recoveringOverflow = true
      return 'retry'
    } catch {
      return undefined
    }
  }

  /** Explicit idle-session checkpoint even below automatic pressure. */
  async compactNow(signal?: AbortSignal): Promise<CompactionResult | null> {
    const controller = signal === undefined ? new AbortController() : undefined
    const effectiveSignal = signal ?? controller?.signal
    if (effectiveSignal === undefined) throw new Error('failed to create compaction signal')
    return this.compactIfNeeded('manual', effectiveSignal)
  }

  private async compactIfNeeded(
    trigger: CompactionTrigger,
    signal: AbortSignal,
    emit?: (event: AgentMaintenanceEvent) => Promise<void>,
  ): Promise<CompactionResult | null> {
    if (this.active) return null
    const deadline = AbortSignal.timeout(this.input.policy.summaryTimeoutMs)
    const operationSignal = AbortSignal.any([signal, deadline])
    operationSignal.throwIfAborted()
    this.active = true
    try {
      const history = this.input.history()
      let surface = history.surface()
      if (surface.length < 2) return null
      const tools = this.input.tools()
      const system = this.input.system()
      const pinned = this.input.pinnedMessages?.() ?? []
      let totalBefore = estimateContextTokens({
        system, messages: [...pinned, ...surface.map(node => node.message)], tools,
      })
      let budget = await this.resolveBudget(totalBefore, operationSignal)
      operationSignal.throwIfAborted()
      if (trigger === 'pressure' && (budget === null || totalBefore < budget.thresholdTokens)) return null
      const pruned = pruneToolResults(history, surface, this.input.policy.maxToolResultChars)
      if (pruned > 0) {
        surface = history.surface()
        totalBefore = estimateContextTokens({
          system, messages: [...pinned, ...surface.map(node => node.message)], tools,
        })
        if (trigger === 'pressure' && budget !== null && totalBefore < budget.thresholdTokens) return null
        // With an absolute threshold and no provider context metadata, retainRatio
        // is inferred from the measured request. Pruning can change that request
        // by orders of magnitude, so selection must use the post-prune budget.
        budget = await this.resolveBudget(totalBefore, operationSignal)
        operationSignal.throwIfAborted()
      }
      const retainTokens = trigger === 'context-overflow'
        ? Math.max(1, estimateMessageTokens(surface.at(-1)?.message))
        : budget?.retainTokens ?? Math.max(1, Math.floor(totalBefore * 0.25))
      const selected = selectCompactablePrefix(surface, retainTokens)
      if (selected.length === 0) return null
      const selectedSeqs = new Set(selected.map(node => node.seq))
      const estimatedNonCompactableTokens = estimateContextTokens({
        system,
        messages: [
          ...pinned,
          ...surface.filter(node => !selectedSeqs.has(node.seq)).map(node => node.message),
        ],
        tools,
      })
      const compactionId = newCompactionId()
      const startedAt = new Date().toISOString()
      history.append({ kind: 'compaction-start', compactionId, trigger, at: startedAt })
      try {
        await this.emitObserver(emit, {
          type: 'compaction-start', compactionId, trigger, estimatedInputTokens: totalBefore,
        })
        const summarized = await this.summarize(
          [...pinned, ...selected.map(node => node.message)], system, tools, operationSignal,
        )
        // Adapters are contractually expected to honor cancellation, but the
        // compactor must not commit stale maintenance if one fails to do so.
        operationSignal.throwIfAborted()
        const checkpoint = createUserMessage({
          source: { kind: 'app', producer: `agent-compaction:${compactionId}` },
          content: [{
            type: 'text',
            text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summarized.summary}\n</compacted-summary>`,
          }],
        })
        const shadowedTokens = selected.reduce((total, node) => total + estimateMessageTokens(node.message), 0)
        const checkpointTokens = estimateMessageTokens(checkpoint)
        if (checkpointTokens >= shadowedTokens) {
          throw new Error(
            `compaction summary did not shrink selected context (${checkpointTokens} >= ${shadowedTokens} estimated tokens)`,
          )
        }
        const shadowedSeqs = Object.freeze(selected.map(node => node.seq))
        const estimatedTokensAfter = Math.max(0, totalBefore - shadowedTokens + checkpointTokens)
        const thresholdTokens = budget?.thresholdTokens
        const pressureBackoff = pressureBackoffReason({
          trigger,
          thresholdTokens,
          estimatedTokensBefore: totalBefore,
          estimatedTokensAfter,
          estimatedNonCompactableTokens,
        })
        history.appendBatch([
          { event: {
            kind: 'compaction-summary', compactionId, summary: summarized.summary, shadowedSeqs,
            estimatedTokensBefore: totalBefore, estimatedTokensAfter,
            provider: summarized.provider, model: summarized.model,
            ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
          } },
          { event: { kind: 'user', message: checkpoint }, surfaceOp: {
            op: 'replace',
            from: Math.min(...shadowedSeqs),
            to: Math.max(...shadowedSeqs),
            targets: shadowedSeqs,
          } },
          { event: {
            kind: 'compaction-end', compactionId, status: 'completed', at: new Date().toISOString(),
            ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
            estimatedNonCompactableTokens,
            ...(pressureBackoff === undefined ? {} : {
              backoffReason: pressureBackoff,
              cooldownSteps: PRESSURE_BACKOFF_STEPS,
            }),
          } },
        ])
        const result: CompactionResult = Object.freeze({
          compactionId, trigger, summary: summarized.summary, shadowedSeqs,
          estimatedTokensBefore: totalBefore, estimatedTokensAfter,
          ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
          estimatedNonCompactableTokens,
          ...(pressureBackoff === undefined ? {} : {
            backoffReason: pressureBackoff,
            cooldownSteps: PRESSURE_BACKOFF_STEPS,
          }),
          provider: summarized.provider, model: summarized.model,
          ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
        })
        await this.emitObserver(emit, {
          type: 'compaction-end', compactionId, trigger, status: 'completed', shadowedSeqs,
          estimatedTokensBefore: totalBefore, estimatedTokensAfter, summary: summarized.summary,
          ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
          estimatedNonCompactableTokens,
          ...(pressureBackoff === undefined ? {} : {
            backoffReason: pressureBackoff,
            cooldownSteps: PRESSURE_BACKOFF_STEPS,
          }),
          ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
        })
        return result
      } catch (error: unknown) {
        const failure = deadline.aborted && !signal.aborted && errorCode(error) !== 'MODEL_TEARDOWN_TIMEOUT'
          ? modelTimeoutError(this.input.policy.summaryTimeoutMs, error)
          : error
        const message = errorMessage(failure)
        try {
          history.append({
            kind: 'compaction-end', compactionId, status: 'failed', at: new Date().toISOString(), error: message,
          })
        } catch {
          // Preserve the original compaction failure when the append-only history
          // has no remaining capacity for the diagnostic end marker.
        }
        await this.emitObserver(emit, {
          type: 'compaction-end', compactionId, trigger, status: 'failed', shadowedSeqs: [],
          estimatedTokensBefore: totalBefore, estimatedTokensAfter: totalBefore, error: message,
        })
        throw failure
      }
    } finally {
      this.active = false
    }
  }

  private async resolveBudget(totalTokens: number, signal: AbortSignal): Promise<ResolvedBudget | null> {
    const policy = this.input.policy
    const config = this.input.config()
    const key = `${config.provider}\u0000${config.model}\u0000${String(config.maxTokens ?? '')}`
    if (this.modelBudget?.key !== key) {
      try {
        const info = await raceWithSignal(this.input.registry.resolveModelInfo(
          config.provider, config.model, signal,
        ), signal)
        const contextWindow = info.context?.contextWindow
        this.modelBudget = { key, budget: contextWindow === undefined
          ? null
          : {
              contextWindow,
              outputReserve: config.maxTokens
                ?? info.defaultMaxTokens
                ?? info.maxOutputTokens
                ?? 0,
            } }
      } catch {
        if (policy.maxInputTokens === undefined) return null
        this.modelBudget = { key, budget: null }
      }
    }
    const contextWindow = this.modelBudget?.budget?.contextWindow
    const inputWindow = contextWindow === undefined
      ? undefined
      : Math.max(1, contextWindow - (this.modelBudget?.budget?.outputReserve ?? 0))
    const ratioThreshold = contextWindow === undefined
      ? undefined
      : Math.floor(contextWindow * policy.thresholdRatio)
    const safeThreshold = inputWindow === undefined || ratioThreshold === undefined
      ? undefined
      : Math.min(inputWindow, ratioThreshold)
    const thresholdTokens = policy.maxInputTokens === undefined
      ? safeThreshold
      : inputWindow === undefined
        ? policy.maxInputTokens
        : Math.min(policy.maxInputTokens, inputWindow)
    if (thresholdTokens === undefined) return null
    const inferredWindow = inputWindow ?? Math.max(totalTokens, Math.ceil(thresholdTokens / policy.thresholdRatio))
    const retainTokens = policy.retainTokens
      ?? Math.floor(inferredWindow * (policy.retainRatio ?? 0.2))
    return { thresholdTokens, retainTokens: Math.max(1, retainTokens) }
  }

  private async emitObserver(
    emit: ((event: AgentMaintenanceEvent) => Promise<void>) | undefined,
    event: AgentMaintenanceEvent,
  ): Promise<void> {
    if (emit === undefined) return
    const pending = Promise.resolve().then(() => emit(event))
    await waitForSettlement(pending, this.input.policy.teardownTimeoutMs)
  }

  private async summarize(
    messages: readonly Message[],
    system: string,
    tools: readonly ModelToolSchema[],
    signal: AbortSignal,
  ): Promise<{ summary: string; provider: string; model: string; usage?: TokenUsage }> {
    const policy = this.input.policy
    const active = this.input.config()
    const provider = policy.summarizationProvider ?? active.provider
    const model = policy.summarizationModel ?? active.model
    const accounting = compactionAccounting(this)
    assertUsageAdmission(accounting)
    const summaryInfo = await raceWithSignal(
      this.input.registry.resolveModelInfo(provider, model, signal),
      signal,
    )
    const maxSummaryTokens = Math.min(
      policy.maxSummaryTokens,
      summaryInfo.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
      summaryInfo.context === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, summaryInfo.context.contextWindow - 1),
    )
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
      if (!exhausted) {
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
      }
    }
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
    if (failure !== undefined) throw failure
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
}

function sanitizeForSummary(
  message: Message,
  maxChars: number,
  budget: CharacterBudget,
): Message {
  const content = message.content.flatMap(block => sanitizeBlock(block, maxChars, budget))
  const source = message.source.kind === 'model'
    ? { kind: 'model' as const, provider: message.source.provider, model: message.source.model }
    : message.source
  return createMessage({ role: message.role, source, content })
}

function sanitizeBlock(
  block: ContentBlock,
  maxChars: number,
  budget: CharacterBudget,
): ContentBlock[] {
  switch (block.type) {
    case 'text': return [{ type: 'text', text: boundedText(block.text, maxChars, budget) }]
    case 'reasoning': return block.text.length === 0 ? [] : [{
      type: 'text', text: boundedText(`[Reasoning summary] ${block.text}`, maxChars, budget),
    }]
    case 'image': return [{ type: 'text', text: boundedText(`[Image input: ${block.source.kind}]`, maxChars, budget) }]
    case 'document': return [{
      type: 'text',
      text: boundedText(`[Document input: ${block.filename ?? block.source.kind}]`, maxChars, budget),
    }]
    case 'tool-call': return [{
      ...block, arguments: boundedToolArguments(block.arguments, maxChars, budget),
    } satisfies ToolCallBlock]
    case 'tool-result': return [{
      ...block,
      content: block.content.flatMap(child => sanitizeBlock(child, maxChars, budget)),
    } satisfies ToolResultBlock]
    case 'native-tool-call': return [{
      type: 'text',
      text: boundedText(
        `[Native tool ${block.name} (${block.status ?? 'unknown'})] ${safeJson(block.arguments ?? {})}`,
        maxChars,
        budget,
      ),
    }]
    default: return [{
      type: 'text', text: boundedText(`[Unsupported content block: ${safeJson(block)}]`, maxChars, budget),
    }]
  }
}

function boundedText(value: string, maxChars: number, budget: CharacterBudget): string {
  const allowed = Math.max(0, Math.min(maxChars, budget.remaining))
  const result = truncateMiddle(value, allowed)
  budget.remaining -= result.length
  return result
}

function boundedToolArguments(value: string, maxChars: number, budget: CharacterBudget): string {
  const allowed = Math.max(0, Math.min(maxChars, budget.remaining))
  if (value.length <= allowed) {
    budget.remaining -= value.length
    return value
  }
  const placeholder = '{"_compacted":true}'
  if (placeholder.length <= allowed) {
    budget.remaining -= placeholder.length
    return placeholder
  }
  return '{}'
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}
function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '\n…[truncated for compaction]…\n'
  if (maxChars <= marker.length) return value.slice(0, maxChars)
  const head = Math.ceil((maxChars - marker.length) / 2)
  const tail = Math.floor((maxChars - marker.length) / 2)
  return value.slice(0, head) + marker + value.slice(value.length - tail)
}
function newCompactionId(): string {
  return systemRandomId()
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('compaction model payload is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

function assertUsageAdmission(accounting: ReturnType<typeof compactionAccounting>): void {
  const stop = accounting?.usageStop
  if (stop !== undefined) throw codedError(
    'compaction cannot dispatch after a mandatory usage stop',
    stop.usageRequired ? 'USAGE_REQUIRED' : 'USAGE_UNAVAILABLE',
  )
}

function codedError(message: string, code: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string }
  error.code = code
  return error
}

function modelTimeoutError(timeoutMs: number, cause: unknown): Error & { code: string } {
  return codedError(`compaction model operation exceeded ${timeoutMs}ms`, 'MODEL_TIMEOUT', cause)
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    throw signal.reason ?? new Error('operation aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('operation aborted'))
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

function pressureBackoffReason(input: {
  readonly trigger: CompactionTrigger
  readonly thresholdTokens: number | undefined
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
  readonly estimatedNonCompactableTokens: number
}): CompactionBackoffReason | undefined {
  if (input.trigger !== 'pressure' || input.thresholdTokens === undefined
    || input.estimatedTokensAfter < input.thresholdTokens) return undefined
  if (input.estimatedNonCompactableTokens >= input.thresholdTokens) {
    return 'unreachable-threshold'
  }
  const savings = input.estimatedTokensBefore - input.estimatedTokensAfter
  const minimum = Math.max(
    MIN_PRESSURE_SAVINGS_TOKENS,
    Math.ceil(input.estimatedTokensBefore * MIN_PRESSURE_SAVINGS_RATIO),
  )
  return savings < minimum ? 'low-savings' : undefined
}
