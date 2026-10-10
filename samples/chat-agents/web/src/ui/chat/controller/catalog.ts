import type { ChatController } from './contracts'
import { CURRENT_KEY, CONVERSATION_PARAM, newConversationId, writeUrl } from './browser'
import { useEffect } from 'react'
import { useCallback } from 'react'
import type { ConversationRow, GroupView } from '@chat-agents/backend'
import type { ControllerContext } from './contracts'
import { GROUP_KEY, GROUP_PARAM, urlParam } from './browser'

export function useRefreshConversations(context: ControllerContext) {
  const { groupId, setConversations } = context
  const refreshConversations = useCallback(async () => {
    if (groupId === '')
      return
    const response = await fetch(`/api/conversations?groupId=${encodeURIComponent(groupId)}`)
    if (!response.ok)
      return
    const body = await response.json() as {
      conversations: ConversationRow[]
    }
    setConversations(body.conversations)
  }, [groupId])
  return refreshConversations
}

export function useRefreshGroups(context: ControllerContext) {
  const { setGroups, setGroupId } = context
  const refreshGroups = useCallback(async () => {
    const response = await fetch('/api/groups')
    if (!response.ok)
      return
    const body = await response.json() as {
      groups: GroupView[]
    }
    setGroups(body.groups)
    // Resolve the stored group only against groups that still exist.
    setGroupId((current) => {
      if (current !== '' && body.groups.some(group => group.id === current))
        return current
      // The URL wins over the stored group so a pasted link opens its project.
      const requested = urlParam(GROUP_PARAM) ?? window.localStorage.getItem(GROUP_KEY)
      const resolved = requested !== null && body.groups.some(group => group.id === requested)
        ? requested
        : body.groups[0]?.id ?? ''
      return resolved
    })
  }, [])
  return refreshGroups
}

export function useInitializeConversation(context: ControllerContext, refreshGroups: ChatController['refreshGroups']) {
  const { shown, setSessionId, sessionId } = context
  useEffect(() => {
    // A conversation id in the URL wins, so a pasted link reopens that chat.
    const requested = urlParam(CONVERSATION_PARAM) ?? window.localStorage.getItem(CURRENT_KEY)
    const id = requested ?? newConversationId()
    window.localStorage.setItem(CURRENT_KEY, id)
    shown.current = id
    setSessionId(id)
    writeUrl({ sessionId: id }, 'replace')
    void refreshGroups()
  }, [refreshGroups])
}

export function useConversationRefreshEffect(
  context: ControllerContext,
  refreshConversations: ChatController['refreshConversations'],
) {
  const {} = context
  useEffect(() => { void refreshConversations(); }, [refreshConversations])
}

export function useMirrorGroup(context: ControllerContext) {
  const { groupId } = context
  useEffect(() => {
    if (groupId === '')
      return
    writeUrl({ groupId }, 'replace')
  }, [groupId])
}
