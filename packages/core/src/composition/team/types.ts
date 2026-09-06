import type { RuntimeAgent, RuntimeAgentInvocationOptions, RuntimeAgentResponse,
  RuntimeAgentSession, RuntimeAgentSessionOptions } from '../agent/types.ts'
import type {
  LinkAgentOptions, SendAgentMessageRequest, SendAgentMessageResult,
} from '../../agent/team/types.ts'
import type { SupportSafeError } from '../../support-safe/error.ts'
import type { RuntimeComponentCloseReport } from '../common/errors.ts'

export interface AgentTeamMemberInput {
  readonly name: string
  readonly agent: RuntimeAgent
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
  readonly session?: RuntimeAgentSessionOptions
}

export type RuntimeAgentTeamEvent =
  | { readonly type: 'member-attached'; readonly member: string }
  | { readonly type: 'member-linked'; readonly member: string; readonly protocol: string }
  | { readonly type: 'message-accepted'; readonly messageId: string; readonly target: string }
  | { readonly type: 'member-run-start'; readonly member: string }
  | { readonly type: 'member-run-end'; readonly member: string }
  | { readonly type: 'member-run-error'; readonly member: string; readonly error: SupportSafeError }
  | { readonly type: 'team-closed'; readonly teamId: string }

export interface RuntimeAgentTeamOptions {
  readonly id: string
  readonly members: readonly AgentTeamMemberInput[]
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  readonly operationTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly onEvent?: (event: RuntimeAgentTeamEvent) => void
}

export interface RuntimeAgentTeam {
  readonly id: string
  readonly memberNames: readonly string[]
  linkAgent(options: LinkAgentOptions): () => void
  sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult>
  session(name: string): RuntimeAgentSession
  run(name: string, input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  close(options?: { readonly signal?: AbortSignal }): Promise<void>
}

export interface RuntimeTeamRegistration {
  readonly id: string
  readonly view: RuntimeAgentTeam
  closeForRuntime(deadlineAt: number): Promise<RuntimeComponentCloseReport>
}
