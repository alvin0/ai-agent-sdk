import type { TeamSessionPort, TeamToolAccess } from './contracts.ts'
import type { AgentMemberOutcome, LinkAgentOptions } from './types.ts'

export interface LocalMemberRuntime {
  readonly kind: 'local'
  readonly name: string
  readonly description?: string
  readonly instructions?: string
  readonly role: 'lead' | 'peer'
  /** Which team verbs it was attached with; shapes its routing guidance. */
  readonly access: TeamToolAccess | false
  readonly session: TeamSessionPort
  wakeRequestedSeq: number
  wakeConsumedSeq: number
  wakeTask: Promise<void> | undefined
  wakeController: AbortController | undefined
  error: string | undefined
  /** How its last run ended, for a coordinator that did not await the run. */
  outcome: AgentMemberOutcome | undefined
  /**
   * Set while the host is holding this member back, and resolved when it lets
   * it start. See {@link AgentTeam.markPending}.
   */
  pendingStart: Promise<void> | undefined
  /**
   * Aborted when the user steers something into this member mid-turn.
   *
   * A member parked in `wait_agents` is not listening to its own conversation:
   * the wait is bounded by its own budget, so a correction typed while it waits
   * sits unread for as long as that budget lasts. Codex's `wait_agent` "ends
   * early when new user input is steered into the active turn" for the same
   * reason. Replaced after each notification, so one interruption ends one
   * wait.
   */
  steerController: AbortController | undefined
}

export interface RemoteMemberRuntime {
  readonly kind: 'remote'
  readonly name: string
  readonly description?: string
  readonly role: 'peer'
  readonly transport: LinkAgentOptions['transport']
  tail: Promise<void>
  pending: number
  readonly controllers: Set<AbortController>
  error: string | undefined
}

export type AddressableMember = LocalMemberRuntime | RemoteMemberRuntime


