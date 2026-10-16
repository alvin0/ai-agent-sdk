import type { Message } from '../../message/index.ts'

const managedNoticeRequests = new WeakMap<object, string>()

/** Internal attribution; ordinary team sends remain delegated input. */
export function managedTeamNoticeRequest<T extends object>(request: T, producer = 'managed-team'): T {
  managedNoticeRequests.set(request, producer)
  return request
}

export function managedTeamNoticeProducer(request: object): string | undefined {
  return managedNoticeRequests.get(request)
}

export function isManagedTeamNoticeRequest(request: object): boolean {
  return managedNoticeRequests.has(request)
}

/** Coordination must be read by the lead without changing the user's task. */
export function isManagedTeamNotice(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'app'
    && (message.source.producer === 'managed-team' || message.source.producer === 'managed-team-settlement')
}
