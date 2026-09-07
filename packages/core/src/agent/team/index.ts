export { AgentTeam } from './team.ts'
export { DEFAULT_MIN_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from './common.ts'

export type {
  TeamMemberAttachmentOptions,
  TeamPort,
  TeamSessionPort,
  TeamToolAccess,
} from './contracts.ts'
export {
  DefinedAgentTeam,
  createDefinedAgentTeam,
  type DefinedAgentTeamMemberInput,
  type DefinedAgentTeamOptions,
} from './composed.ts'
export {
  ManagedAgentTeam,
  createManagedAgentTeam,
  DEFAULT_SPAWN_SETUP_TIMEOUT_MS,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  completedHistoryPrefix,
  type ManagedAgentRole,
  type ManagedAgentSpawnContext,
  type ManagedAgentSpawnRequest,
  type ManagedAgentTeamOptions,
  type ManagedAgentWorker,
  type ManagedAgentWorkerStatus,
  type ManagedAgentWorkerResult,
  type ResolvedManagedAgentSpawnRequest,
  type WriteScopeConflictPolicy,
} from './managed.ts'

export type {
  AgentMessageDelivery,
  AgentMessageRecord,
  AgentMessageSource,
  AgentTeamEvent,
  AgentMemberOutcome,
  AgentTeamMember,
  AgentTeamMemberOptions,
  AgentTeamOptions,
  LinkedAgentResult,
  LinkedAgentSendInput,
  LinkedAgentTransport,
  LinkAgentOptions,
  SendAgentMessageRequest,
  SendAgentMessageResult,
} from './types.ts'
