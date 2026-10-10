import { useCallback } from 'react'
import { deleteTranscript } from '../idb'
import type { ChatController, ControllerContext } from './contracts'
import { newConversationId } from './browser'

export function useRemoveConversation(
  context: ControllerContext,
  openConversation: ChatController['openConversation'],
  refreshConversations: ChatController['refreshConversations'],
) {
  const { runs, sessionId } = context
  const removeConversation = useCallback(async (id: string) => {
    // The one case where a run really is over: its conversation is gone, so
    // nothing is left for it to write into.
    runs.current.get(id)?.controller.abort()
    await fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    })
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
    await deleteTranscript(id)
    await refreshConversations()
    if (id === sessionId)
      openConversation(newConversationId())
  }, [openConversation, refreshConversations, sessionId])
  return removeConversation
}

export function useRenameConversation(
  context: ControllerContext,
  refreshConversations: ChatController['refreshConversations'],
) {
  const {} = context
  const renameConversation = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    await refreshConversations()
  }, [refreshConversations])
  return renameConversation
}
