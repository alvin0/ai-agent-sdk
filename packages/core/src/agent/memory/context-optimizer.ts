import type { Message } from '../../message/index.ts'
import type { TurnHooks } from '../loop/events.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { readSpillTool } from '../tool/output-budget.ts'
import { estimateMessageTokens } from './token-estimator.ts'
import { ObservationProjector } from './context-observations.ts'
import { MilestoneProjector } from './context-milestones.ts'
import { positive, byteLength, optimizerConfig, type OptimizerConfig } from './context-optimizer-support.ts'
import type { ContextMilestone, ContextOptimizerOptions,
  ContextOptimizationMetrics, MutableOptimizationMetrics } from './context-optimizer-types.ts'
export type {
  ContextMilestone, ContextOptimizerOptions, ContextOptimizationMetrics,
} from './context-optimizer-types.ts'

/**
 * One controller per session. Projection affects requests only; snapshots retain raw history.
 * Compose its hooks with application hooks using wrapHooks(), and register retrievalTool.
 * Disposal drops projection state, never tool receipts or host-owned storage.
 */
export function createContextOptimizer(options: ContextOptimizerOptions) {
  const controller = new ContextOptimizerController(options)
  return Object.freeze({
    hooks: controller.hooks,
    retrievalTool: controller.retrievalTool,
    completeMilestone(milestone: ContextMilestone): void { controller.completeMilestone(milestone) },
    wrapHooks(application: TurnHooks = {}): TurnHooks { return controller.wrapHooks(application) },
    metrics(): ContextOptimizationMetrics { return Object.freeze({ ...controller.counters }) },
    dispose(): void { controller.dispose() },
  })
}

class ContextOptimizerController {
  readonly config: OptimizerConfig
  readonly counters: MutableOptimizationMetrics = {
    packedObservations: 0, verifiedReductions: 0, rejectedReductions: 0,
    compactedMilestones: 0, skippedMilestones: 0, estimatedTokensSaved: 0,
  }
  readonly retrievalTool: ToolDefinition
  readonly hooks: TurnHooks
  private readonly observations: ObservationProjector
  private readonly milestones: MilestoneProjector
  private readonly milestoneIds = new Set<string>()
  private disposed = false
  private active = false
  private scope: string | undefined
  private readonly lifetime = new AbortController()

  constructor(options: ContextOptimizerOptions) {
    this.config = optimizerConfig(options)
    this.retrievalTool = readSpillTool(this.config.store)
    this.observations = new ObservationProjector(
      this.config, this.counters, () => this.disposed, this.retrievalTool.name,
    )
    this.milestones = new MilestoneProjector(this.config.archive, this.counters, () => this.disposed)
    this.hooks = Object.freeze({ beforeStep: this.beforeStep, checkpoint: this.checkpoint })
  }

  private readonly prepare: NonNullable<TurnHooks['beforeStep']> = async context => {
    let messages: readonly Message[] = await this.observations.project(context)
    if (this.disposed) return { kind: 'proceed', messages: context.messages }
    context.signal.throwIfAborted()
    messages = await this.milestones.project({ ...context, messages }, context.messages)
    if (this.disposed) return { kind: 'proceed', messages: context.messages }
    context.signal.throwIfAborted()
    const before = context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    const after = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    this.counters.estimatedTokensSaved += Math.max(0, before - after)
    return { kind: 'proceed', messages: Object.freeze(messages) }
  }

  readonly beforeStep: NonNullable<TurnHooks['beforeStep']> = async context => {
    if (this.disposed) return { kind: 'proceed', messages: context.messages }
    if (this.active) return { kind: 'reject',
      reason: 'Context optimizer already has a prepare in flight; use one controller per session.' }
    const first = context.snapshot.entries.find(entry => 'message' in entry.event)
    const identity = first !== undefined && 'message' in first.event ? String(first.event.message.id) : undefined
    if (this.scope !== undefined && identity !== this.scope) return { kind: 'reject',
      reason: 'Context optimizer belongs to a different history; create a fresh controller after reset/resume.' }
    this.scope ??= identity
    this.active = true
    try { return await this.prepare({ ...context, signal: AbortSignal.any([context.signal, this.lifetime.signal]) }) }
    finally { this.active = false }
  }

  readonly checkpoint: NonNullable<TurnHooks['checkpoint']> = context => {
    if (this.disposed || context.kind !== 'before-model-request') return
    for (const message of context.request.messages ?? []) {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        block.content.forEach((_child, index) => {
          const observation = this.observations.observations.get(`${message.id}:${block.toolCallId}:${index}`)
          if (observation !== undefined) observation.exposures++
        })
      }
    }
  }

  completeMilestone(milestone: ContextMilestone): void {
    if (this.disposed) throw new Error('context optimizer is disposed')
    if (this.milestoneIds.size >= this.config.maxMilestones) {
      throw new RangeError('context optimizer milestone capacity reached')
    }
    validateMilestone(milestone, this.milestoneIds)
    this.milestoneIds.add(milestone.id)
    this.milestones.pending.push(Object.freeze({ ...milestone }))
  }

  /** Application hooks run first; checkpoints count after host persistence succeeds. */
  wrapHooks(application: TurnHooks): TurnHooks {
    const beforeStep = this.beforeStep
    const checkpoint = this.checkpoint
    return {
      ...application,
      async beforeStep(context) {
        const decision = await application.beforeStep?.(context)
        if (decision?.kind === 'reject') return decision
        const optimized = await beforeStep({ ...context, messages: decision?.messages ?? context.messages })
        return { ...optimized, ...decision?.prepend === undefined ? {} : { prepend: decision.prepend } }
      },
      async checkpoint(context) { await application.checkpoint?.(context); await checkpoint(context) },
    }
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort(new Error('Context optimizer disposed'))
    this.observations.observations.clear()
    this.milestones.pending.length = 0
    this.milestones.completed.length = 0
    this.milestoneIds.clear()
  }
}

function validateMilestone(milestone: ContextMilestone, milestoneIds: ReadonlySet<string>): void {
  if (!milestone.id.trim() || !milestone.summary.trim() || milestoneIds.has(milestone.id)) {
    throw new TypeError('milestone requires a unique id and non-empty summary')
  }
  if (byteLength(milestone.id) > 128 || byteLength(milestone.summary) > 8192) {
    throw new RangeError('milestone id/summary exceeds 128/8192 bytes')
  }
  positive(milestone.throughSeq, 'throughSeq')
  positive(milestone.remainingTurns, 'remainingTurns')
  validateMilestoneCosts(milestone)
}

function validateMilestoneCosts(milestone: ContextMilestone): void {
  if (!Number.isFinite(milestone.compactionCost) || milestone.compactionCost < 0
    || !Number.isFinite(milestone.historyTokenCost ?? 1) || (milestone.historyTokenCost ?? 1) <= 0) {
    throw new RangeError('milestone costs must be finite and non-negative; token cost must be positive')
  }
}
