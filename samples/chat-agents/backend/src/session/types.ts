import type { AgentRunEvent, History, ManagedAgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import type { InteractiveUserInputBroker } from '@alvin0/ai-agent-sdk-core'
import type { ApprovalPolicy } from '../approvals'
import type { StoredNode } from '../event-projection'
import type { WireEvent } from '../wire'

/**
 * Something that happened outside the run's own event stream and still belongs
 * in the transcript: a permission answer, which arrives on its own request.
 */
export interface OutboxEntry {
  /** Omitted when the client already rendered the change it made itself. */
  readonly wire?: WireEvent
  readonly node?: StoredNode
}

export interface ChatSession {
  readonly id: string
  readonly history: History
  readonly broker: InteractiveUserInputBroker
  /**
   * Tool families the user permitted "for this session".
   *
   * Owned by the session rather than by a run, so the grant survives from one
   * prompt to the next and is dropped by `forgetSession`.
   */
  readonly sessionGrants: Set<string>
  /** Answers to permission prompts, waiting to be folded into the live run. */
  readonly outbox: OutboxEntry[]
  /** The gate for the run in flight, and the handle `POST /approve` answers. */
  approvals: ApprovalPolicy | undefined
  /**
   * The dynamic-team harness, kept for the whole conversation.
   *
   * A worker outlives the run that spawned it, so the run cannot own the
   * harness: rebuilding it per prompt would strand the previous prompt's
   * workers with nothing left to stop them.
   */
  managed: ManagedAgentTeam | undefined
  /**
   * Where worker events go right now.
   *
   * Re-pointed at each run, because the harness captures its callback once.
   * Between runs it still has somewhere to go — a worker that finishes after
   * the stream closed belongs in the transcript, not in the bin.
   */
  workerSink: ((member: string, event: AgentRunEvent) => void) | undefined
  /** Hands the run in flight a message; absent when nothing is running. */
  steerRun: ((text: string) => boolean) | undefined
  /**
   * Set when the user steered, cleared when a model round starts.
   *
   * Still set once the run has ended means the message arrived after the last
   * round: nothing read it, and nothing ever will unless the run is continued.
   */
  steerUnread: boolean
  /** Wakes the run generator after another request adds to `outbox`. */
  notify: (() => void) | undefined
  abort: AbortController | undefined
  /** Transcript position for the next persisted node. */
  seq: number
}

export interface SessionStore {
  readonly sessions: Map<string, ChatSession>
  pending?: Map<string, Promise<ChatSession>>
}
