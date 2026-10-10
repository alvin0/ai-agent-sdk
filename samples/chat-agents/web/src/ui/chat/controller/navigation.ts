import { urlParam, CONVERSATION_PARAM } from './browser'
import { useEffect } from 'react'
import { useCallback } from 'react'
import type { ChatController, ControllerContext } from './contracts'
import { CURRENT_KEY, newConversationId, writeUrl } from './browser'

export function useApplyConversation(context: ControllerContext) {
  const { shown, setSessionId, runs, setState } = context
  const applyConversation = useCallback((id: string): boolean => {
    // Opening the conversation already open is nothing to do — and doing it
    // anyway emptied the screen: the rows below are replaced with a blank
    // state for the loader to fill, and the loader is keyed on the session id,
    // which did not change. A second click on the open row left the transcript
    // gone with nothing on its way to bring it back.
    if (id === shown.current)
      return false
    window.localStorage.setItem(CURRENT_KEY, id)
    shown.current = id
    setSessionId(id)
    const live = runs.current.get(id)
    setState(live === undefined
      ? {
        nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
        progress: null, members: [], spans: [], runId: '',
      }
      : {
        nodes: live.nodes, running: true, usage: live.usage,
        progress: live.progress, members: live.members,
        spans: live.spans, runId: live.runId,
      })
    return true
  }, [])
  return applyConversation
}

export function useOpenConversation(context: ControllerContext, applyConversation: (id: string) => boolean) {
  const { sessionId } = context
  const openConversation = useCallback((id: string) => {
    // No switch, no history entry: a second click on the open row would
    // otherwise stack Back steps that go nowhere.
    if (!applyConversation(id))
      return
    writeUrl({ sessionId: id }, 'push')
  }, [applyConversation])
  return openConversation
}

export function useNewConversation(context: ControllerContext, openConversation: ChatController['openConversation']) {
  const {} = context
  const newConversation = useCallback(() => {
    openConversation(newConversationId())
  }, [openConversation])
  return newConversation
}

export function useHistoryNavigation(context: ControllerContext, applyConversation: (id: string) => boolean) {
  const { sessionId } = context
  useEffect(() => {
    const onPop = (): void => {
      const id = urlParam(CONVERSATION_PARAM)
      if (id === null || id === sessionId)
        return
      applyConversation(id)
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop); }
  }, [applyConversation, sessionId])
}
