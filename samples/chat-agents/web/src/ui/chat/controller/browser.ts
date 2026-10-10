export const CURRENT_KEY = 'chat-agents.conversation'
export const GROUP_KEY = 'chat-agents.group'

export function newConversationId(): string {
  return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
export const CONVERSATION_PARAM = 'c'
export const GROUP_PARAM = 'g'

export function urlParam(key: string): string | null {
  if (typeof window === 'undefined')
    return null
  const value = new URLSearchParams(window.location.search).get(key)
  return value === null || value === '' ? null : value
}

export function writeUrl(ids: {
  readonly sessionId?: string
  readonly groupId?: string
}, mode: 'push' | 'replace'): void {
  if (typeof window === 'undefined')
    return
  const url = new URL(window.location.href)
  if (ids.sessionId !== undefined && ids.sessionId !== '') {
    url.searchParams.set(CONVERSATION_PARAM, ids.sessionId)
  }
  if (ids.groupId !== undefined && ids.groupId !== '') {
    url.searchParams.set(GROUP_PARAM, ids.groupId)
  }
  if (url.href === window.location.href)
    return
  if (mode === 'push')
    window.history.pushState(null, '', url)
  else
    window.history.replaceState(null, '', url)
}
