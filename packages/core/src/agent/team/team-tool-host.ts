import type { AgentTeam } from './team.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'

export interface TeamToolsHost {
  readonly waitTimeoutMs: number
  readonly minWaitTimeoutMs: number
  assertActive(): void
  members: AgentTeam['members']
  sendMessage: AgentTeam['sendMessage']
  followup: AgentTeam['followup']
  beginWait: AgentTeam['beginWait']
  whenIdle: AgentTeam['whenIdle']
  member(name: string): LocalMemberRuntime | undefined
}
