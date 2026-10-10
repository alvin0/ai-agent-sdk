import { showRun } from './view'
import { requestRun } from './request'
import { readStream } from './stream'
import { createRun, reportRunError } from './live-run'
import { settleRun } from './settlement'
import { useCallback } from 'react'
import type { WireAttachment } from '@chat-agents/backend'
import type { ChatController, ControllerContext } from './contracts'

export function useSend(context: ControllerContext, refreshConversations: ChatController['refreshConversations']) {
  const { sessionId, groupId, state, runs, setRunningIds } = context
  const send = useCallback(async (
    prompt: string,
    attachments: readonly WireAttachment[] = [],
    skillIds: readonly string[] = [],
  ) => {
    // The group has to be resolved: a run started without one creates the
    // conversation in the default project, and the agent then writes into the
    // sample's own sandbox instead of the folder on screen.
    //
    // Attachments are a message of their own: dropping a screenshot in and
    // pressing Enter with nothing typed is a complete thing to say.
    if (sessionId === '' || groupId === '')
      return
    if (prompt.trim() === '' && attachments.length === 0)
      return
    // Captured now: every update below belongs to THIS conversation, whatever
    // the user is looking at by the time the event arrives.
    const id = sessionId
    const run = createRun({ state, prompt, attachments, skillIds })
    const controller = run.controller
    runs.current.set(id, run)
    setRunningIds([...runs.current.keys()])
    /** Mirror the run onto the screen, but only while it is the one open. */
    const show = (): void => { showRun(context, id, run); }
    show()
    // The row exists the moment the run does — the server creates it before
    // its first event — but the sidebar only ever refreshed at the END of a
    // run, so a conversation started and left to work was invisible for as
    // long as it took.
    void refreshConversations()
    try {
      const response = await requestRun({
        sessionId: id, prompt, groupId, attachments, skillIds, signal: controller.signal,
      })
      if (response.body === null)
        throw new Error('the server returned no stream')
      await readStream(response.body, run, show)
    }
    catch (error) {
      reportRunError(run, error, show)
    }
    finally {
      settleRun(context, id, run, refreshConversations)
    }
  }, [sessionId, groupId, state.nodes, state.usage, refreshConversations])
  return send
}
