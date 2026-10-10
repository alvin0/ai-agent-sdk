import { History } from '../../history/history.ts'
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
      const candidate = History.fromSnapshot(this.host.history().snapshot(), this.host.historyLimits())
      candidate.appendBatch([
        ...(this.pendingInjections?.entries() ?? []).map(entry => ({ event: entry.event })),
        { event: { kind: 'user' as const, message } },
      ])
      const pending = this.pendingInjections ??= new History(this.host.historyLimits())
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
