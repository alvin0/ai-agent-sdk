import { useEffect } from 'react'
import type { ChatNode } from '../types'
import { writeTranscript } from '../idb'
import type { ControllerContext } from './contracts'
import { readTranscript } from '../idb'
import type { WireApproval, WireQuestion } from '@chat-agents/backend'

export function useTranscript(context: ControllerContext) {
  const { sessionId, runs, setState, answered } = context
  useEffect(() => {
    if (sessionId === '')
      return
    // A conversation still running is already on screen from its own buffer,
    // which is ahead of both the cache and the server's settled copy. Reading
    // either one here would rewind it.
    if (runs.current.has(sessionId))
      return
    let cancelled = false
    void (async () => {
      const cached = await readTranscript(sessionId)
      if (!cancelled && cached !== undefined) {
        setState(previous => ({ ...previous, nodes: cached }))
      }
      const response = await fetch(`/api/conversations/${sessionId}`)
      if (!response.ok || cancelled)
        return
      const body = await response.json() as {
        messages: ChatNode[]
        pendingApprovals?: readonly WireApproval[]
        pendingQuestions?: readonly {
          requestId: string
          questions: readonly WireQuestion[]
        }[]
      }
      // Neither a waiting permission prompt nor an open question is in the
      // transcript — both live in the run — so they are appended rather than
      // replayed, and deliberately kept out of the local cache. Without the
      // questions a reload left the run parked on an answer the user could no
      // longer give, because the card it needed was gone.
      const parked: ChatNode[] = [
        ...(body.pendingApprovals ?? [])
          .map(approval => ({ kind: 'approval' as const, id: approval.callId, ...approval })),
        ...(body.pendingQuestions ?? []).map(open => ({
          kind: 'question' as const,
          id: open.requestId,
          requestId: open.requestId,
          questions: open.questions,
          answered: false,
        })),
      ]
      if (body.messages.length === 0 && cached !== undefined) {
        if (parked.length > 0)
          setState(previous => ({ ...previous, nodes: [...cached, ...parked] }))
        return
      }
      setState(previous => ({ ...previous, nodes: [...body.messages, ...parked] }))
      await writeTranscript(sessionId, body.messages)
    })()
    return () => { cancelled = true; }
  }, [sessionId])
}

export function useCacheTranscript(context: ControllerContext) {
  const { sessionId, state } = context
  useEffect(() => {
    if (sessionId === '' || state.running)
      return
    void writeTranscript(sessionId, state.nodes)
  }, [sessionId, state.nodes, state.running])
}
