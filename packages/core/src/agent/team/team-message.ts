import type { ContentBlock } from '../../message/index.ts'
import type { AgentMessageRecord, AgentMessageDelivery, SendAgentMessageRequest, LinkedAgentResult } from './types.ts'
import type { LocalMemberRuntime, AddressableMember } from './team-runtime-types.ts'
import { messageContent, byteLength, deepCloneFreeze } from './common.ts'

export function messageDelivery(sender: LocalMemberRuntime, target: AddressableMember,
  request: SendAgentMessageRequest): AgentMessageDelivery {
    if (target.kind === 'local' && sender === target) throw new Error('an A2A member cannot message itself')
  const delivery = request.delivery ?? 'quiet'
    if (delivery !== 'quiet' && delivery !== 'wakeup') {
      throw new TypeError("A2A delivery must be 'quiet' or 'wakeup'")
    }
    if (target.kind === 'remote' && delivery === 'quiet') {
      throw new Error(
        `remote A2A member '${target.name}' cannot accept quiet injection; use followup_task or delivery 'wakeup'`,
      )
    }
  return delivery
}

export function frameTeamMessage(id: string, sender: LocalMemberRuntime,
  request: SendAgentMessageRequest, maxMessageBytes: number) {
    const content = messageContent(request.message, maxMessageBytes)
    const framed = deepCloneFreeze([
      { type: 'text' as const, text: `A2A message ${id} from ${sender.name}:` },
      ...content,
    ])
    const contentBytes = byteLength(framed)
    if (contentBytes > maxMessageBytes) {
      throw new Error(`A2A message exceeds the ${maxMessageBytes}-byte limit`)
    }
  return { framed, contentBytes }
}

export function acceptedMessageRecord(
  identity: { readonly id: string; readonly teamId: string; readonly sender: LocalMemberRuntime;
    readonly target: AddressableMember },
  delivery: AgentMessageDelivery,
  payload: { readonly framed: readonly ContentBlock[]; readonly result: LinkedAgentResult | undefined },
): AgentMessageRecord {
  const { id, teamId, sender, target } = identity
  const { framed, result } = payload
  return deepCloneFreeze({
        id, teamId, sender: sender.name,
        senderAgentId: sender.session.definition.id,
        target: target.name,
        targetAgentId: target.kind === 'local'
          ? target.session.definition.id
          : target.transport.agentId,
        delivery, content: framed, status: 'accepted' as const,
        createdAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result }),
      })
}
