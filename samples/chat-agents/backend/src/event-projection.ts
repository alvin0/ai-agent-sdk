/**
 * Raw SDK events → wire events + the settled transcript nodes to store.
 *
 * One projector serves a whole run: the lead's own stream and every team
 * member's callback, keyed by source, so two agents streaming at once cannot
 * merge into one another's text node.
 */

import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import type {
  ToolCard, WireApproval, WireApprovalScope, WireAttachment, WireEvent, WireQuestion,
} from './wire'

/** A settled transcript node, in the shape the frontend renders. */
export type StoredNode =
  | {
      kind: 'user'; id: string; text: string
      attachments?: readonly WireAttachment[]
      /** Skill ids the message named with `/`, matched against the catalogue. */
      skills?: readonly string[]
    }
  | { kind: 'text'; id: string; text: string; phase: string; streaming: false; member?: string; incomplete?: true }
  | { kind: 'reasoning'; id: string; text: string; member?: string }
  | {
      kind: 'tool'; id: string; name: string; args: string
      state: 'ok' | 'error' | 'declined'; output?: string; card?: ToolCard; errorMessage?: string
      /** Set when the loop shortened the result to fit the model's context. */
      shortened?: 'truncated' | 'spilled'
      member?: string
    }
  | { kind: 'question'; id: string; requestId: string; questions: readonly WireQuestion[]; answered: boolean }
  /**
   * A settled permission decision. Only stored once answered: a prompt still
   * waiting is replayed from the live broker, not from the transcript.
   */
  | (WireApproval & {
      kind: 'approval'
      id: string
      decision: 'allow' | 'deny' | 'abort'
      scope: WireApprovalScope
      /** The rule the grant was stored under; absent when nothing was. */
      ruleKey?: string
      member?: string
    })
  | { kind: 'notice'; id: string; level: 'info' | 'warn'; message: string; member?: string }
  | { kind: 'error'; id: string; message: string }

function textOf(content: readonly { readonly type: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function cardOf(meta: Readonly<Record<string, unknown>> | undefined): ToolCard | undefined {
  const value = meta?.card
  return typeof value === 'object' && value !== null ? (value as ToolCard) : undefined
}

interface OpenText {
  text: string
  phase: string
  member: string | undefined
  incomplete?: true
}

/** Per-source position, so ids stay stable while two agents interleave. */
interface Cursor {
  turn: number
  step: number
}

export interface EventProjectorOptions {
  /**
   * The prompt text for a parked call.
   *
   * The SDK's `approval-request` carries the raw arguments; the human-readable
   * title, summary, and preview are the approval policy's, so the projector
   * looks them up rather than re-deriving them.
   */
  readonly approval?: (callId: string) => WireApproval | undefined
}

export class EventProjector {
  /** True when the run's outcome comes from a run handle instead of an event. */
  private handleOwnsOutcome = false
  private readonly options: EventProjectorOptions
  private readonly cursors = new Map<string, Cursor>()
  private readonly openText = new Map<string, OpenText>()
  private readonly openReasoning = new Map<string, OpenText>()
  private readonly openTools = new Map<string, { name: string; args: string; member?: string }>()
  private readonly pending: StoredNode[] = []

  constructor(options: EventProjectorOptions = {}) {
    this.options = options
  }

  /**
   * Project one event from the agent the user is talking to.
   * @param event - The raw SDK event.
   * @returns Wire events, in order.
   */
  forLead(event: AgentRunEvent): readonly WireEvent[] {
    return this.project(event, undefined)
  }

  /**
   * Project one event produced by a team member.
   * @param member - The member's name.
   * @param event - The raw SDK event.
   * @returns Wire events, in order.
   */
  forMember(member: string, event: AgentRunEvent): readonly WireEvent[] {
    return this.project(event, member)
  }

  /**
   * Take the transcript nodes settled since the last call.
   * @returns The settled nodes; the buffer is emptied.
   */
  flush(): readonly StoredNode[] {
    const taken = [...this.pending]
    this.pending.length = 0
    return taken
  }

  /**
   * Close every still-open text and reasoning block at the end of a run.
   * @returns The nodes those blocks settle into.
   */
  settled(): readonly StoredNode[] {
    const nodes: StoredNode[] = []
    for (const [id, entry] of this.openText) {
      nodes.push({
        kind: 'text', id, text: entry.text, phase: entry.phase, streaming: false,
        ...entry.incomplete ? { incomplete: true as const } : {},
        ...entry.member === undefined ? {} : { member: entry.member },
      })
    }
    this.openText.clear()
    for (const [id, entry] of this.openReasoning) {
      nodes.push({
        kind: 'reasoning', id, text: entry.text,
        ...entry.member === undefined ? {} : { member: entry.member },
      })
    }
    this.openReasoning.clear()
    return nodes
  }

  /**
   * Say that the caller reports the outcome from the run handle.
   *
   * A session emits `agent-end` as well, so without this the run would end
   * twice — once from the event and once from the awaited result.
   */
  deferOutcomeToHandle(): void {
    this.handleOwnsOutcome = true
  }

  /** Record one settled node for the caller to persist. */
  push(node: StoredNode): void {
    this.pending.push(node)
  }

  private cursor(source: string): Cursor {
    const existing = this.cursors.get(source)
    if (existing !== undefined) return existing
    const created = { turn: 0, step: 0 }
    this.cursors.set(source, created)
    return created
  }

  private key(source: string, kind: 't' | 'r', index: number): string {
    const cursor = this.cursor(source)
    // The separator keeps a member's ids from colliding with the lead's, whose
    // source is the empty string.
    return `${source}:${String(cursor.turn)}.${String(cursor.step)}.${kind}${String(index)}`
  }

  /**
   * Settle the blocks one author has open.
   *
   * The author is matched on the recorded member rather than on the id's
   * prefix: the lead's source is the empty string, which every member's id
   * starts with, so a prefix test closed a member's open block on the lead's
   * step boundary and the member's next delta reopened the same id — two
   * transcript nodes sharing one id.
   */
  private closeText(member: string | undefined): WireEvent[] {
    const events: WireEvent[] = []
    for (const [id, entry] of [...this.openText]) {
      if (entry.member !== member) continue
      this.openText.delete(id)
      this.pending.push({
        kind: 'text', id, text: entry.text, phase: entry.phase, streaming: false,
        ...entry.incomplete ? { incomplete: true as const } : {},
        ...entry.member === undefined ? {} : { member: entry.member },
      })
      events.push({ t: 'text-end', id })
    }
    for (const [id, entry] of [...this.openReasoning]) {
      if (entry.member !== member) continue
      this.openReasoning.delete(id)
      this.pending.push({
        kind: 'reasoning', id, text: entry.text,
        ...entry.member === undefined ? {} : { member: entry.member },
      })
    }
    return events
  }

  private project(event: AgentRunEvent, member: string | undefined): readonly WireEvent[] {
    const source = member ?? ''
    const tag = member === undefined ? {} : { member }

    switch (event.type) {
      case 'turn-start':
        this.cursor(source).turn = event.turn
        return []
      case 'step-start':
        this.cursor(source).step = event.step
        return []
      case 'text-delta': {
        const id = this.key(source, 't', event.index)
        const current = this.openText.get(id)
        const phase = event.phase === 'commentary' || event.phase === 'final-answer'
          ? event.phase
          : current?.phase ?? 'unknown'
        this.openText.set(id, { text: (current?.text ?? '') + event.text, phase, member })
        return [{ t: 'text-delta', id, text: event.text, phase: phase as 'commentary' | 'final-answer' | 'unknown', ...tag }]
      }
      case 'text-end': {
        const id = this.key(source, 't', event.index)
        const partial = event.incomplete ? { incomplete: true as const } : {}
        this.openText.set(id, { text: event.text, phase: event.phase, member, ...partial })
        return [{ t: 'text-end', id, text: event.text, phase: event.phase, ...tag, ...partial }]
      }
      case 'reasoning-delta': {
        const id = this.key(source, 'r', event.index)
        const current = this.openReasoning.get(id)
        this.openReasoning.set(id, { text: (current?.text ?? '') + event.text, phase: 'reasoning', member })
        return [{ t: 'reasoning-delta', id, text: event.text, ...tag }]
      }
      case 'step-end':
        return this.closeText(member)
      case 'tool-call':
        this.openTools.set(event.call.callId, {
          name: event.call.toolName,
          args: event.call.rawArguments,
          ...tag,
        })
        return [{
          t: 'tool-call',
          id: event.call.callId,
          name: event.call.toolName,
          args: event.call.rawArguments,
          ...tag,
        }]
      case 'tool-result': {
        const result = event.result
        // A call the loop refused to run — a spent budget, a repeat guard. It
        // neither failed nor did anything, and painting it red is what made a
        // working limit look like a crash.
        const declined = !result.isError && result.meta?.['declined'] === true
        // The loop keeps one result from spending the whole context window: it
        // either cut the middle out or saved the full text and left a locator.
        // Either way the row should say so rather than presenting a fragment
        // as the whole output.
        const shortened = result.meta?.['outputSpilled'] !== undefined
          ? 'spilled' as const
          : result.meta?.['outputTruncated'] !== undefined ? 'truncated' as const : undefined
        const card = cardOf(result.meta)
        const call = this.openTools.get(event.call.callId)
        this.openTools.delete(event.call.callId)
        const output = textOf(result.content)
        this.pending.push({
          kind: 'tool',
          id: event.call.callId,
          name: call?.name ?? event.call.toolName,
          args: call?.args ?? event.call.rawArguments,
          state: result.isError ? 'error' : declined ? 'declined' : 'ok',
          ...shortened === undefined ? {} : { shortened },
          output,
          ...card === undefined ? {} : { card },
          ...result.isError ? { errorMessage: result.error.message } : {},
          ...tag,
        })
        return [{
          t: 'tool-result',
          id: event.call.callId,
          ok: !result.isError,
          ...declined ? { declined: true as const } : {},
          ...shortened === undefined ? {} : { shortened },
          output,
          ...card === undefined ? {} : { card },
          ...result.isError ? { errorMessage: result.error.message } : {},
          ...tag,
        }]
      }
      case 'usage':
        return [{
          t: 'usage',
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
        }]
      case 'user-input-request': {
        const questions = event.request.questions.map(question => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map(option => ({
            label: option.label,
            description: option.description,
          })),
        }))
        this.pending.push({
          kind: 'question',
          id: event.request.requestId,
          requestId: event.request.requestId,
          questions,
          answered: false,
        })
        return [{ t: 'question', requestId: event.request.requestId, questions }]
      }
      case 'user-input-response':
        return [{ t: 'question-answered', requestId: event.request.requestId }]
      case 'approval-request': {
        const prompt = this.options.approval?.(event.request.approvalRequestId)
        // No prompt means an interceptor other than the sample's policy asked.
        // Its `reason` is written for the model, not for a card, so the
        // fallback names the tool instead of quoting it — but the call is still
        // surfaced, because parking one invisibly would hang the run.
        return [{
          t: 'approval',
          ...prompt ?? {
            callId: event.request.approvalRequestId,
            providerCallId: event.request.providerCallId,
            toolName: event.request.toolName,
            title: event.request.toolName,
            summary: 'This call needs your permission.',
            // No rules: this policy did not raise the ask, so it has no key it
            // could honour later. The call is permitted once or not at all.
            rules: [],
          },
          ...tag,
        }]
      }
      case 'agent-end': {
        // A member's own outcome is not the run's outcome: only the agent the
        // user is talking to ends the run.
        if (member !== undefined) {
          if (event.outcome.completed) return []
          const reason = event.outcome.reason
          const detail = reason.kind === 'error' ? reason.failure.message
            : reason.kind === 'budget-exhausted' ? reason.trigger === 'report-reserve'
              ? 'research stopped to reserve token capacity for the final report'
              : reason.budget === 'tokens' ? 'hard cumulative token limit reached' : `${reason.budget} limit`
              : reason.kind === 'completed' ? 'self-check was not accepted for this run' : reason.kind
          const message = `Worker '${member}' did not complete its task (${detail}). Treat any available findings as partial.`
          this.pending.push({ kind: 'notice', id: `${source}:incomplete:${String(Date.now())}`, level: 'warn', message, member })
          return [{ t: 'notice', level: 'warn', message, member }]
        }
        if (this.handleOwnsOutcome) return []
        // The session shapes report their outcome through the run handle, so
        // this only fires for the single-agent loop.
        const reason = event.outcome.reason
        if (reason.kind === 'error') {
          const message = reason.failure.message
          this.pending.push({ kind: 'error', id: `e_${message.length}_${String(Date.now())}`, message })
          return [{ t: 'error', message }, { t: 'run-end', reason: reason.kind, text: event.outcome.text }]
        }
        return [{ t: 'run-end', reason: reason.kind, text: event.outcome.text }]
      }
      default:
        return []
    }
  }
}
