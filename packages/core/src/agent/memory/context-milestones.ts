import { createMessage, type Message } from '../../message/index.ts'
import { projectHistorySurface } from '../history/project.ts'
import type { BeforeStepContext } from '../loop/events.ts'
import type {
  ContextMilestone, ContextOptimizerOptions, MutableOptimizationMetrics,
} from './context-optimizer-types.ts'
import { balanced } from './context-optimizer-support.ts'
import { estimateMessageTokens } from './token-estimator.ts'

interface Completed {
  readonly targets: ReadonlySet<string>
  readonly inputs: ReadonlyMap<string, string>
  readonly message: Message
}

export class MilestoneProjector {
  readonly pending: ContextMilestone[] = []
  readonly completed: Completed[] = []
  private completedThroughSeq = 0

  constructor(
    private readonly archive: ContextOptimizerOptions['archive'],
    private readonly metrics: MutableOptimizationMetrics,
    private readonly isDisposed: () => boolean,
  ) {}

  async project(context: BeforeStepContext, sourceMessages: readonly Message[]): Promise<readonly Message[]> {
    const fingerprints = new Map((this.completed.length || this.pending.length ? sourceMessages : [])
      .map(message => [String(message.id),
        JSON.stringify({ content: message.content, source: message.source, role: message.role })]))
    for (const milestone of this.pending.splice(0)) {
      if (!await this.acceptMilestone(milestone, context, fingerprints)) break
    }
    return this.applyCompleted(context.messages, fingerprints)
  }

  private async acceptMilestone(
    milestone: ContextMilestone, context: BeforeStepContext, fingerprints: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    const messages = this.milestoneMessages(milestone, context)
    if (messages === undefined) { this.metrics.skippedMilestones++; return true }
    const summary = createMessage({ role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `[Completed ${milestone.id}: ${milestone.summary}]` }] })
    if (!worthCompacting(messages, summary, milestone) || this.archive === undefined) {
      this.metrics.skippedMilestones++; return true
    }
    try {
      await this.archive(context.snapshot, milestone, context.signal)
      if (this.isDisposed()) return false
      context.signal.throwIfAborted()
    } catch {
      if (this.isDisposed()) return false
      context.signal.throwIfAborted()
      this.metrics.skippedMilestones++; return true
    }
    this.completed.push({ targets: new Set(messages.map(message => message.id)),
      inputs: new Map(messages.map(message => [String(message.id), fingerprints.get(message.id)!])), message: summary })
    this.completedThroughSeq = milestone.throughSeq
    this.metrics.compactedMilestones++
    return true
  }

  private milestoneMessages(milestone: ContextMilestone, context: BeforeStepContext): Message[] | undefined {
    if (milestone.throughSeq > (context.snapshot.entries.at(-1)?.seq ?? 0)) return undefined
    const surface = projectHistorySurface(context.snapshot.entries)
    const visible = new Set(context.messages.map(message => message.id))
    // Preserve the initial request and injected state. Only completed, balanced ranges.
    const nodes = surface.slice(1).filter(node => node.seq > this.completedThroughSeq
      && node.seq <= milestone.throughSeq && node.message.source.kind !== 'app' && visible.has(node.message.id))
    const byId = new Map(context.messages.map(message => [message.id, message]))
    const messages = nodes.map(node => byId.get(node.message.id)!)
    const covered = new Set(this.completed.flatMap(group => [...group.targets]))
    if (nodes.length === 0 || nodes.some(node => covered.has(node.message.id)) || !balanced(messages)) return undefined
    return messages
  }

  private applyCompleted(source: readonly Message[], fingerprints: ReadonlyMap<string, string>): Message[] {
    let messages = [...source]
    // If regular pressure compaction shadows a target, its summary owns that range.
    for (let i = this.completed.length - 1; i >= 0; i--) {
      const group = this.completed[i]!
      const visible = new Set(messages.map(message => String(message.id)))
      if (![...group.targets].every(id => visible.has(id) && fingerprints.get(id) === group.inputs.get(id))) {
        this.completed.splice(i, 1); continue
      }
      const first = messages.findIndex(message => group.targets.has(message.id))
      const retained = messages.filter(message => !group.targets.has(message.id))
      retained.splice(first, 0, group.message)
      messages = retained
    }
    return messages
  }
}

function worthCompacting(messages: readonly Message[], summary: Message, milestone: ContextMilestone): boolean {
  const saved = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    - estimateMessageTokens(summary)
  return !(saved <= 0
    || milestone.compactionCost >= saved * milestone.remainingTurns * (milestone.historyTokenCost ?? 1))
}
