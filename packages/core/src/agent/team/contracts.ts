/** Inward structural contracts shared by sessions and the team control plane. */

import type { UserMessage } from '../../message/index.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { ToolDefinition } from '../tool/definition.ts'

/**
 * How much of the team tool set one member may use.
 *
 * `full` is every verb. `reporting` withholds the two that BLOCK or DELEGATE —
 * `wait_agents` and `followup_task` — leaving `list_agents` and `send_message`.
 *
 * The distinction exists because an agent created to carry out one bounded task
 * needs a stopping point, and the coordination verbs take it away: given them,
 * a worker that wants guidance messages a peer and then waits, so its run ends
 * only when something cancels it. Whoever is orchestrating keeps those verbs.
 */
export type TeamToolAccess = 'full' | 'reporting'

/** Team-owned metadata applied while attaching one local session. */
export interface TeamMemberAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  /** `false` attaches no team tools; a {@link TeamToolAccess} narrows them. */
  readonly tools?: boolean | TeamToolAccess
}

/**
 * The smallest session surface required by local team orchestration.
 *
 * `AgentSession` satisfies this interface structurally. Keeping the concrete
 * class out of the control plane prevents definition/session ownership from
 * pointing back out to the team implementation.
 */
export interface TeamSessionPort {
  readonly definition: { readonly id: string }
  readonly conversationId: string
  readonly isRunning: boolean
  inject(input: UserMessage): number
  whenIdle(signal?: AbortSignal): Promise<void>
  runPending(invocation?: {
    readonly signal?: AbortSignal
    readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
  }): Promise<unknown>
}

/** Session-facing surface of a team control plane. */
export interface TeamPort {
  attach(session: TeamSessionPort, options?: TeamMemberAttachmentOptions): void
  toolsFor(sender: string, access?: TeamToolAccess): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}
