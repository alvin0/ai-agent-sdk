/** Inward structural contracts shared by sessions and the team control plane. */

import type { UserMessage } from '../../message/index.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { ToolDefinition } from '../tool/definition.ts'

/** Team-owned metadata applied while attaching one local session. */
export interface TeamMemberAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
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
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}
