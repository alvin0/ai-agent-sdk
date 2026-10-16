import type { AgentTeam } from './team.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'

export interface TeamToolsHost {
  readonly waitTimeoutMs: number
  readonly minWaitTimeoutMs: number
  assertActive(): void
  retainedResult(name: string): import('./types.ts').AgentTeamMember | undefined
  takeResults: AgentTeam['takeResults']
  captureResults: AgentTeam['captureResults']
  members: AgentTeam['members']
  sendMessage: AgentTeam['sendMessage']
  followup: AgentTeam['followup']
  beginWait: AgentTeam['beginWait']
  whenIdle: AgentTeam['whenIdle']
  member(name: string): LocalMemberRuntime | undefined
}
