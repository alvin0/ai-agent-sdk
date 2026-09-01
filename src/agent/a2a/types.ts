/** Public identities, delivery values, and event records for local and remote A2A. */

import type { ContentBlock } from '@ai-agent-sdk/core'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentTeam } from './team.ts'

export type { AgentMessageSource } from '@ai-agent-sdk/core'

/** A quiet delivery adds context; a wakeup delivery also schedules a turn. */
export type AgentMessageDelivery = 'quiet' | 'wakeup'

/** Attach a session to one shared A2A control plane. */
export interface AgentTeamMemberOptions {
  readonly team: AgentTeam
  /** Stable model-facing address; defaults to the agent definition id. */
  readonly name?: string
  readonly description?: string
  /** Extra model-facing collaboration policy for this member. */
  readonly instructions?: string
  /** The first attached member defaults to lead; later members default to peer. */
  readonly role?: 'lead' | 'peer'
  /** Expose list_agents, send_message, followup_task, and wait_agents to this model. */
  readonly tools?: boolean
}

/** Detached runtime view of one addressable member. */
export interface AgentTeamMember {
  readonly name: string
  readonly agentId: string
  readonly kind: 'local' | 'remote'
  readonly conversationId?: string
  readonly role: 'lead' | 'peer'
  readonly status: 'running' | 'idle' | 'failed'
  readonly protocol?: string
  readonly deliveries: readonly AgentMessageDelivery[]
  readonly description?: string
  readonly error?: string
}

/** Transport-neutral result returned by an externally linked agent. */
export interface LinkedAgentResult {
  readonly kind: 'message' | 'task'
  readonly succeeded: boolean
  readonly text: string
  readonly contextId: string
  readonly taskId?: string
  readonly state?: string
}

export interface LinkedAgentSendInput {
  readonly teamId: string
  readonly messageId: string
  readonly sender: string
  readonly senderAgentId: string
  readonly content: readonly ContentBlock[]
  readonly signal?: AbortSignal
}

/** A remote protocol transport that can be linked into an AgentTeam roster. */
export interface LinkedAgentTransport {
  readonly protocol: string
  readonly agentId: string
  send(input: LinkedAgentSendInput): Promise<LinkedAgentResult>
}

export interface LinkAgentOptions {
  readonly name: string
  readonly description?: string
  readonly transport: LinkedAgentTransport
}

export interface SendAgentMessageRequest {
  /** Sender name registered in the same team. */
  readonly from: string
  /** Target member name. */
  readonly target: string
  readonly message: string | readonly ContentBlock[]
  readonly delivery?: AgentMessageDelivery
  readonly signal?: AbortSignal
}

/** Immutable mailbox record retained by the control plane. */
export interface AgentMessageRecord {
  readonly id: string
  readonly teamId: string
  readonly sender: string
  readonly senderAgentId: string
  readonly target: string
  readonly targetAgentId: string
  readonly delivery: AgentMessageDelivery
  readonly content: readonly ContentBlock[]
  readonly status: 'accepted'
  readonly createdAt: string
  readonly result?: LinkedAgentResult
}

export interface SendAgentMessageResult {
  readonly messageId: string
  /** Local history owns the message, or the remote protocol call returned successfully. */
  readonly status: 'accepted'
  readonly delivery: AgentMessageDelivery
  readonly target: string
  readonly result?: LinkedAgentResult
}

export type AgentTeamEvent =
  | { readonly type: 'member-attached'; readonly member: AgentTeamMember }
  | { readonly type: 'member-linked'; readonly member: AgentTeamMember }
  | { readonly type: 'message-accepted'; readonly message: AgentMessageRecord }
  | { readonly type: 'member-run-start'; readonly member: string }
  | { readonly type: 'member-run-end'; readonly member: string }
  | { readonly type: 'member-run-cancelled'; readonly member: string }
  | { readonly type: 'member-run-error'; readonly member: string; readonly error: string }
  | { readonly type: 'team-disposed'; readonly teamId: string }

export interface AgentTeamOptions {
  readonly id?: string
  readonly maxMembers?: number
  /** Maximum number of accepted messages retained for audit. Defaults to 10,000. */
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  /** Maximum serialized result retained from one linked transport. Defaults to 1 MiB. */
  readonly maxLinkedResultBytes?: number
  /** Maximum cumulative serialized content/result bytes retained by the mailbox. Defaults to 64 MiB. */
  readonly maxMailboxBytes?: number
  /** Maximum serialized bytes for descriptions and collaboration instructions. Defaults to 8 KiB. */
  readonly maxMetadataBytes?: number
  /** Maximum time dispose waits for cooperative transports/providers. Defaults to 30 seconds. */
  readonly disposeTimeoutMs?: number
  /** End-to-end bound for one remote dispatch or local wake-up batch. Defaults to 10 minutes. */
  readonly operationTimeoutMs?: number
  /** Maximum wait per asynchronous agent-event observer. Defaults to 1 second. */
  readonly observerTimeoutMs?: number
  readonly onEvent?: (event: AgentTeamEvent) => void
  /** Observe model/tool/compaction events from local wake-up runs. */
  readonly onAgentEvent?: (member: string, event: AgentRunEvent) => void | Promise<void>
}
