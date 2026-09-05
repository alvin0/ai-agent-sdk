import {
  AgentTeam,
  DefinedAgentTeam,
  ManagedAgentTeam,
  createDefinedAgentTeam,
  createManagedAgentTeam,
  type AgentMessageDelivery,
  type AgentMessageRecord,
  type AgentTeamEvent,
  type AgentTeamMember,
  type AgentTeamMemberOptions,
  type AgentTeamOptions,
  type DefinedAgentTeamMemberInput,
  type DefinedAgentTeamOptions,
  type LinkAgentOptions,
  type LinkedAgentResult,
  type LinkedAgentSendInput,
  type LinkedAgentTransport,
  type ManagedAgentSpawnRequest,
  type ManagedAgentTeamOptions,
  type ManagedAgentWorker,
  type ManagedAgentWorkerResult,
  type ResolvedManagedAgentSpawnRequest,
  type SendAgentMessageRequest,
  type SendAgentMessageResult,
  type TeamMemberAttachmentOptions,
  type TeamPort,
  type TeamSessionPort,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentTeamApiShape = [
  Assert<Equivalent<AgentMessageDelivery, 'quiet' | 'wakeup'>>,
  Assert<Equivalent<AgentMessageRecord['status'], 'accepted'>>,
  Assert<Equivalent<SendAgentMessageResult['status'], 'accepted'>>,
  Assert<Equivalent<AgentTeamMember['kind'], 'local' | 'remote'>>,
]

export type AgentTeamTypeInventory = [
  AgentTeamEvent,
  AgentTeamMemberOptions,
  AgentTeamOptions,
  DefinedAgentTeamMemberInput,
  LinkAgentOptions,
  LinkedAgentResult,
  LinkedAgentSendInput,
  LinkedAgentTransport,
  ManagedAgentSpawnRequest,
  ManagedAgentWorker,
  ManagedAgentWorkerResult,
  ResolvedManagedAgentSpawnRequest,
  SendAgentMessageRequest,
  TeamMemberAttachmentOptions,
  TeamPort,
  TeamSessionPort,
]

const transport: LinkedAgentTransport = {
  protocol: 'compatibility',
  agentId: 'remote-agent',
  async send(input) {
    return {
      kind: 'message',
      succeeded: true,
      text: input.messageId,
      contextId: input.teamId,
    }
  },
}

/** Representative legacy team source compiled unchanged on both modules. */
export function exerciseAgentTeamApi(
  definedOptions: DefinedAgentTeamOptions,
  managedOptions: ManagedAgentTeamOptions,
): readonly [DefinedAgentTeam, ManagedAgentTeam] {
  const team = new AgentTeam({ id: 'compatibility-team' })
  const unlink = team.linkAgent({ name: 'remote', transport })
  void team.members()
  void team.messages()
  void team.instructionsFor('remote')
  void team.toolsFor('remote')
  void team.whenIdle('remote')
  void team.cancel('remote')
  void team.dispose()
  void unlink

  const defined = createDefinedAgentTeam(definedOptions)
  const managed = createManagedAgentTeam(managedOptions)
  void new DefinedAgentTeam(definedOptions)
  void new ManagedAgentTeam(managedOptions)
  return [defined, managed]
}
