import { History, type HistoryLimits } from '../../history/history.ts'
import { resolveHistoryLimits } from '../../history/config.ts'
import type { ResolvedImageRetentionOptions } from '../../history/image-retention.ts'
import { preRetentionLimits } from '../../history/image-retention-storage.ts'
import { isManagedTeamNotice } from '../../history/input-work.ts'
import { bindModelRequestBoundary, bindQueuedInput } from '../../loop/turn/model-request-boundary.ts'
import type { AgentRunEvent, AgentRunOutcome } from '../../mode/run-agent.ts'
import type { AgentInput, AgentSessionOptions } from './types.ts'
import { userMessage } from './common.ts'
interface SessionInputHost {
  history(): History
  historyLimits(): AgentSessionOptions['historyLimits']
  isRunning(): boolean
}
function pendingLimits(
  limits: AgentSessionOptions['historyLimits'],
  retention: ResolvedImageRetentionOptions | undefined,
): HistoryLimits | undefined {
  return retention?.persist === 'drop-pruned' ? preRetentionLimits(resolveHistoryLimits(limits ?? {})) : limits
}

function isChatSpanStart(event: AgentRunEvent): boolean {
  return event.type === 'span-start' && event.kind === 'chat'
}

function eventCalledTool(event: AgentRunEvent): boolean {
  return event.type === 'tool-call'
    || (event.type === 'assistant-message'
      && event.message?.content.some(block => block.type === 'tool-call') === true)
}

function eventEndsRound(event: AgentRunEvent, calledTools: boolean): boolean {
  return (event.type === 'step-end' && calledTools)
    || event.type === 'turn-end' || event.type === 'agent-end'
}

/** Owns queued input and round admission without owning session execution. */
export class SessionInputState {
  private pendingInjections: History | undefined
  private lastRunOutcome: AgentRunOutcome | undefined
  private roundInFlight = false
  private roundCalledTools = false
  constructor(private readonly host: SessionInputHost) {}
  inject(input: AgentInput): number {
    const message = userMessage(input)
    if (this.host.isRunning() && this.roundInFlight) {
      const history = this.host.history()
      // Mirror the live retention policy so the trial prunes exactly like the real append will.
      const candidate = History.fromSnapshot(history.snapshot(), this.host.historyLimits(),
        history.imageRetentionPolicy())
      candidate.appendBatch([
        ...(this.pendingInjections?.entries() ?? []).map(entry => ({ event: entry.event })),
        { event: { kind: 'user' as const, message } },
      ])
      // The trial above enforced the live limits after retention. The buffer holds
      // raw input that the live history may still prune, so it only needs a memory guard.
      const pending = this.pendingInjections ??= new History(
        pendingLimits(this.host.historyLimits(), history.imageRetentionPolicy()))
      pending.append({ kind: 'user', message })
      return this.host.history().entries().length + pending.entries().length
    }
    this.drainInjections()
    this.host.history().append({ kind: 'user', message })
    return this.host.history().entries().length
  }

  observeRoundBoundary(event: AgentRunEvent): void {
    if (event.type === 'agent-end') this.lastRunOutcome = event.outcome
    if (isChatSpanStart(event)) {
      this.roundInFlight = true
      this.roundCalledTools = false
      return
    }
    if (!this.roundInFlight) return
    if (eventCalledTool(event)) this.roundCalledTools = true
    if (eventEndsRound(event, this.roundCalledTools)) {
      this.roundInFlight = false
      this.drainInjections()
    }
  }

  drainInjections(): void {
    if (this.pendingInjections === undefined) return
    const pending = this.pendingInjections
    this.host.history().appendBatch(pending.entries().map(entry => ({ event: entry.event })))
    this.pendingInjections = undefined
  }

  hasUnansweredInput(): boolean {
    if ((this.pendingInjections?.entries().length ?? 0) > 0) return true
    for (const message of [...this.host.history().messages()].reverse()) {
      if (message.source.kind === 'app') {
        if (message.source.producer === 'turn-interrupted') return false
        if (message.role === 'user' && !isManagedTeamNotice(message)) continue
      }
      return message.role === 'user'
    }
    return false
  }

  lastOutcome(): AgentRunOutcome | undefined { return this.lastRunOutcome }

  snapshotHistory(): ReturnType<History['snapshot']> {
    const history = this.host.history().snapshot()
    const pending = this.pendingInjections?.entries() ?? []
    return pending.length === 0 ? history : Object.freeze({
      version: 1 as const,
      entries: Object.freeze([...history.entries, ...pending.map((entry, index) => Object.freeze({
        ...entry, seq: history.entries.length + index + 1,
      }))]),
    })
  }
  reset(): void {
    this.pendingInjections = undefined
    this.lastRunOutcome = undefined
  }
  releaseRound(): void { this.roundInFlight = false }
  bindBoundaries(): void {
    bindModelRequestBoundary(this.host.history(), inFlight => {
      this.roundInFlight = inFlight
      if (!inFlight) this.drainInjections()
    })
    bindQueuedInput(this.host.history(), () => {
      // Refused admission may leave an empty buffer; it must not extend the run.
      if (!this.hasExtendingInput()) return false
      this.roundInFlight = false
      this.drainInjections()
      return true
    }, () => this.hasExtendingInput())
  }
  private hasExtendingInput(): boolean {
    // Ordinary team deliveries remain queued for their wake-up runPending().
    return (this.pendingInjections?.entries() ?? []).some(entry => entry.event.kind === 'user'
      && (entry.event.message.source.kind === 'user' || isManagedTeamNotice(entry.event.message)))
  }
}
