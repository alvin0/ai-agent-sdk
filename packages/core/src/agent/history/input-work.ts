import type { Message } from '../../message/index.ts'

const managedNoticeRequests = new WeakSet<object>()

/** Internal attribution; ordinary team sends remain delegated input. */
export function managedTeamNoticeRequest<T extends object>(request: T): T {
  managedNoticeRequests.add(request)
  return request
}

export function isManagedTeamNoticeRequest(request: object): boolean {
  return managedNoticeRequests.has(request)
}

/** Coordination must be read by the lead without changing the user's task. */
export function isManagedTeamNotice(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'app' && message.source.producer === 'managed-team'
}
