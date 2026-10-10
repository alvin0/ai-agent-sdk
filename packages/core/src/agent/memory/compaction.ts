import {
  appendCheckpoint, belowPressure, compactionRetainTokens, createCheckpoint,
  errorCode, errorMessage, newCompactionId, pressureBackoffReason, PRESSURE_BACKOFF_STEPS,
} from './compaction-checkpoint.ts'
import { resolveCompactionBudget, modelCompactionBudget, type ResolvedBudget } from './compaction-budget.ts'
import { CompactionSummarizer } from './compaction-summary.ts'
import { modelTimeoutError, raceWithSignal } from './compaction-errors.ts'
export { COMPACTION_INSTRUCTION } from './compaction-content.ts'
/** Context-pressure compaction inspired by Codex checkpoints and deepseek-harness surface replacement. */

import type { CallConfig } from '../../contract/index.ts'
import type { ModelToolSchema } from '../../contract/index.ts'
import type { Message } from '../../message/index.ts'
import type { ModelRegistry } from '../../runtime/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { TokenUsage } from '../../stream/index.ts'
import type { History } from '../history/history.ts'
import type {
  AgentMaintenanceEvent, BeforeStepContext, CompactionBackoffReason, CompactionTrigger, RequestErrorContext,
} from '../loop/events.ts'
import type { AgentCompactionConfig } from './compaction-config.ts'
import type { RunReport } from '../accounting/delivery-types.ts'
import { pruneToolResults, selectCompactablePrefix } from './surface-compaction.ts'
import { estimateContextTokens } from './token-estimator.ts'

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
    await this.maintainPressure(context)
  }

  private async maintainPressure(context: BeforeStepContext): Promise<void> {
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
      const plan = await this.prepareCompaction(trigger, operationSignal)
      if (plan === null) return null
      return await this.executeCompaction(plan, { trigger, signal, deadline, operationSignal, emit })
    } finally {
      this.active = false
    }
  }

  private async prepareCompaction(trigger: CompactionTrigger, operationSignal: AbortSignal) {
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
    if (belowPressure(trigger, budget, totalBefore, true)) return null
    const pruned = pruneToolResults(history, surface, this.input.policy.maxToolResultChars)
    if (pruned > 0) {
      surface = history.surface()
      totalBefore = estimateContextTokens({
        system, messages: [...pinned, ...surface.map(node => node.message)], tools,
      })
      if (belowPressure(trigger, budget, totalBefore, false)) return null
      // With an absolute threshold and no provider context metadata, retainRatio
      // is inferred from the measured request. Pruning can change that request
      // by orders of magnitude, so selection must use the post-prune budget.
      budget = await this.resolveBudget(totalBefore, operationSignal)
      operationSignal.throwIfAborted()
    }
    const retainTokens = compactionRetainTokens({ trigger, surface, budget, totalBefore })
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
    return { history, pinned, selected, totalBefore, budget, system, tools, estimatedNonCompactableTokens }
  }

  private async executeCompaction(
    plan: NonNullable<Awaited<ReturnType<ContextCompactor['prepareCompaction']>>>,
    invocation: {
      trigger: CompactionTrigger
      signal: AbortSignal
      deadline: AbortSignal
      operationSignal: AbortSignal
      emit: ((event: AgentMaintenanceEvent) => Promise<void>) | undefined
    },
  ): Promise<CompactionResult> {
    const { history, totalBefore } = plan
    const { trigger, signal, deadline, emit } = invocation
    const compactionId = newCompactionId()
    const startedAt = new Date().toISOString()
    history.append({ kind: 'compaction-start', compactionId, trigger, at: startedAt })
    try {
      return await this.completeCompaction(plan, invocation, compactionId)
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
  }

  private async completeCompaction(
    plan: NonNullable<Awaited<ReturnType<ContextCompactor['prepareCompaction']>>>,
    invocation: {
      trigger: CompactionTrigger
      operationSignal: AbortSignal
      emit: ((event: AgentMaintenanceEvent) => Promise<void>) | undefined
    },
    compactionId: string,
  ): Promise<CompactionResult> {
    const { history, pinned, selected, totalBefore, budget, system, tools, estimatedNonCompactableTokens } = plan
    const { trigger, operationSignal, emit } = invocation
    await this.emitObserver(emit, {
      type: 'compaction-start', compactionId, trigger, estimatedInputTokens: totalBefore,
    })
    const summarized = await new CompactionSummarizer(this.input, this).summarize(
      [...pinned, ...selected.map(node => node.message)], system, tools, operationSignal,
    )
    // Adapters are contractually expected to honor cancellation, but the
    // compactor must not commit stale maintenance if one fails to do so.
    operationSignal.throwIfAborted()
    const { checkpoint, shadowedTokens, checkpointTokens } = createCheckpoint(
      compactionId, summarized.summary, selected,
    )
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
    appendCheckpoint(history, checkpoint, {
      compactionId, summarized, shadowedSeqs, totalBefore, estimatedTokensAfter,
      thresholdTokens, estimatedNonCompactableTokens, pressureBackoff,
    })
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
    await this.emitCompleted(emit, result)
    return result
  }

  private async emitCompleted(
    emit: ((event: AgentMaintenanceEvent) => Promise<void>) | undefined,
    result: CompactionResult,
  ): Promise<void> {
    await this.emitObserver(emit, {
      type: 'compaction-end', compactionId: result.compactionId, trigger: result.trigger,
      status: 'completed',
      shadowedSeqs: result.shadowedSeqs,
      estimatedTokensBefore: result.estimatedTokensBefore, estimatedTokensAfter: result.estimatedTokensAfter,
      summary: result.summary,
      ...(result.thresholdTokens === undefined ? {} : { thresholdTokens: result.thresholdTokens }),
      estimatedNonCompactableTokens: result.estimatedNonCompactableTokens,
      ...(result.backoffReason === undefined ? {} : {
        backoffReason: result.backoffReason,
        cooldownSteps: PRESSURE_BACKOFF_STEPS,
      }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    })
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
        this.modelBudget = { key, budget: modelCompactionBudget(config, info) }
      } catch {
        if (policy.maxInputTokens === undefined) return null
        this.modelBudget = { key, budget: null }
      }
    }
    return resolveCompactionBudget(policy, this.modelBudget?.budget, totalTokens)
  }

  private async emitObserver(
    emit: ((event: AgentMaintenanceEvent) => Promise<void>) | undefined,
    event: AgentMaintenanceEvent,
  ): Promise<void> {
    if (emit === undefined) return
    const pending = Promise.resolve().then(() => emit(event))
    await waitForSettlement(pending, this.input.policy.teardownTimeoutMs)
  }


}
