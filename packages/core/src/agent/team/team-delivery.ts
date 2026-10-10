import type { AddressableMember, LocalMemberRuntime, RemoteMemberRuntime } from './team-runtime-types.ts'
import type { TeamMailbox } from './team-mailbox.ts'
import type { dispatchRemote } from './team-remote.ts'
import type { AgentTeamEvent, LinkedAgentResult, SendAgentMessageRequest, SendAgentMessageResult } from './types.ts'
import { messageDelivery, frameTeamMessage, acceptedMessageRecord } from './team-message.ts'
import { createUserMessage } from '../../message/index.ts'
import { isManagedTeamNoticeRequest } from '../history/input-work.ts'
import { newMessageId, byteLength, deepCloneFreeze } from './common.ts'

interface DeliveryHost {
  readonly teamId: string
  readonly maxMessageBytes: number
  readonly maxLinkedResultBytes: number
  readonly mailbox: TeamMailbox
  requireLocalMember(name: string): LocalMemberRuntime
  requireAddress(name: string): AddressableMember
  scheduleWake(member: LocalMemberRuntime, seq: number): void
  dispatchRemote(member: RemoteMemberRuntime, input: Parameters<typeof dispatchRemote>[1]): Promise<LinkedAgentResult>
  emit(event: AgentTeamEvent): void
}

export async function sendTeamMessage(
  request: SendAgentMessageRequest, host: DeliveryHost,
): Promise<SendAgentMessageResult> {
  request.signal?.throwIfAborted()
  const sender = host.requireLocalMember(request.from)
  const target = host.requireAddress(request.target)
  const delivery = messageDelivery(sender, target, request)
  const id = newMessageId()
  const { framed, contentBytes } = frameTeamMessage(id, sender, request, host.maxMessageBytes)
  const reservedBytes = target.kind === 'remote'
    ? contentBytes + host.maxLinkedResultBytes
    : contentBytes
  const releaseReservation = host.mailbox.reserve(reservedBytes)
  let result: LinkedAgentResult | undefined
  try {
    if (target.kind === 'local') {
      const message = createUserMessage({
        source: isManagedTeamNoticeRequest(request) ? { kind: 'app' as const, producer: 'managed-team' } : {
          kind: 'agent-message' as const,
          teamId: host.teamId, messageId: id, sender: sender.name,
          senderAgentId: sender.session.definition.id,
        },
        content: framed,
      })
      const seq = target.session.inject(message)
      if (delivery === 'wakeup') host.scheduleWake(target, seq)
    } else {
      result = await host.dispatchRemote(target, {
        teamId: host.teamId, messageId: id, sender: sender.name,
        senderAgentId: sender.session.definition.id, content: framed,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    }
    const record = acceptedMessageRecord({ id, teamId: host.teamId, sender, target }, delivery, { framed, result })
    const retainedBytes = contentBytes + (result === undefined ? 0 : byteLength(result))
    host.mailbox.accept(record, retainedBytes)
    host.emit({ type: 'message-accepted', message: deepCloneFreeze(record) })
    return deepCloneFreeze({
      messageId: id, status: 'accepted' as const, delivery, target: target.name,
      ...(result === undefined ? {} : { result }),
    })
  } finally {
    releaseReservation()
  }
}
