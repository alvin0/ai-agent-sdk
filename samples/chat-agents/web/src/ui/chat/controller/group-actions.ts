import { useCallback } from 'react'
import type { GroupRow } from '@chat-agents/backend'
import type { ChatController, ControllerContext } from './contracts'
import { CURRENT_KEY, GROUP_KEY, newConversationId, writeUrl } from './browser'

export function useOpenGroup(context: ControllerContext) {
  const { setGroupId, shown, setSessionId, setState, sessionId, groupId } = context
  const openGroup = useCallback((id: string) => {
    window.localStorage.setItem(GROUP_KEY, id)
    setGroupId(id)
    // A conversation belongs to one group, so switching group starts a new one.
    const fresh = newConversationId()
    window.localStorage.setItem(CURRENT_KEY, fresh)
    shown.current = fresh
    setSessionId(fresh)
    setState({
      nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
      progress: null, members: [], spans: [], runId: '',
    })
    writeUrl({ sessionId: fresh, groupId: id }, 'push')
  }, [])
  return openGroup
}

export function useCreateGroup(
  context: ControllerContext,
  openGroup: ChatController['openGroup'],
  refreshGroups: ChatController['refreshGroups'],
) {
  const {} = context
  const createGroup = useCallback(async (workspaceRoot: string) => {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot }),
    })
    if (!response.ok)
      return undefined
    const body = await response.json() as {
      group: GroupRow
    }
    await refreshGroups()
    openGroup(body.group.id)
    return body.group
  }, [openGroup, refreshGroups])
  return createGroup
}

export function useDeleteGroup(context: ControllerContext, refreshGroups: ChatController['refreshGroups']) {
  const { groupId, setGroupId } = context
  const deleteGroup = useCallback(async (id: string) => {
    await fetch(`/api/groups/${id}`, { method: 'DELETE' })
    await refreshGroups()
    // Deleting the open project drops back to whichever project remains.
    if (id === groupId)
      setGroupId('')
  }, [groupId, refreshGroups])
  return deleteGroup
}

export function useRevealGroup(context: ControllerContext) {
  const {} = context
  const revealGroup = useCallback(async (id: string) => {
    await fetch(`/api/groups/${id}/reveal`, { method: 'POST' })
  }, [])
  return revealGroup
}
