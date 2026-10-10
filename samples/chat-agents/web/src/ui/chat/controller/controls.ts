import { useCallback } from 'react'
import type { WireApprovalScope } from '@chat-agents/backend'
import type { ChatNode } from '../types'
import type { ChatController, ControllerContext, EditNodes } from './contracts'

export function useAnswer(context: ControllerContext) {
  const { sessionId } = context
  const answer = useCallback(async (requestId: string, answers: Record<string, string>) => {
    await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, requestId, answers }),
    })
  }, [sessionId])
  return answer
}

export function useApprove(context: ControllerContext, editNodes: EditNodes) {
  const { answered, sessionId } = context
  const approve = useCallback(async (
    callId: string,
    decision: 'allow' | 'deny',
    scope: WireApprovalScope,
    ruleKey?: string,
  ) => {
    if (answered.current.has(callId))
      return
    answered.current.add(callId)
    // Settle the node here, not on the server's confirmation. The released
    // call reports back through the run's own stream, which does not emit
    // again until the tool FINISHES — an `npm install` would leave the prompt
    // on screen for a minute after it was answered.
    const settle = (answer: {
      decision: 'allow' | 'deny'
      scope: WireApprovalScope
      ruleKey?: string
    } | undefined) => {
      editNodes(sessionId, (previous) => {
        const index = previous.findIndex(node => node.kind === 'approval' && node.callId === callId)
        if (index === -1)
          return previous
        const nodes = [...previous]
        const { decision: _was, scope: _reach, ruleKey: _rule, ...pending } = nodes[index] as Extract<ChatNode, {
          kind: 'approval'
        }>
        nodes[index] = answer === undefined ? pending : { ...pending, ...answer }
        return nodes
      })
    }
    settle({ decision, scope, ...ruleKey === undefined ? {} : { ruleKey } })
    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, callId, decision, scope, ruleKey }),
      })
      const body = await response.json() as {
        resolved?: boolean
      }
      // Nothing was released — the run ended or the server restarted while the
      // card was open. Put the prompt back rather than leaving a decision on
      // screen that never reached the call.
      if (!response.ok || body.resolved !== true) {
        answered.current.delete(callId)
        settle(undefined)
      }
    }
    catch {
      answered.current.delete(callId)
      settle(undefined)
    }
  }, [sessionId, editNodes])
  return approve
}

export function useSteer(context: ControllerContext, send: ChatController['send'], editNodes: EditNodes) {
  const { sessionId } = context
  const steer = useCallback(async (prompt: string, skillIds: readonly string[] = []) => {
    const text = prompt.trim()
    if (sessionId === '' || text === '')
      return
    // Shown immediately: the message is already in the agent's history, and
    // the run's own stream carries no echo of it.
    editNodes(sessionId, previous => [...previous, {
        kind: 'user',
        id: `u_${String(Date.now())}_steer`,
        text,
        at: Date.now(),
        ...skillIds.length === 0 ? {} : { skills: skillIds },
      }])
    const response = await fetch('/api/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: text, skillIds }),
    })
    const body = await response.json().catch(() => ({})) as {
      steered?: boolean
    }
    // The run ended between the keystroke and the request. The message would
    // otherwise be silently dropped, so send it as an ordinary prompt — minus
    // the user node just added, which `send` appends again.
    if (body.steered !== true) {
      editNodes(sessionId, previous => previous.filter(
        node => !(node.kind === 'user' && node.text === text && node.id.endsWith('_steer')),
      ))
      await send(text, [], skillIds)
    }
  }, [sessionId, send, editNodes])
  return steer
}

export function useStop(context: ControllerContext) {
  const { sessionId, runs } = context
  const stop = useCallback(() => {
    void fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    runs.current.get(sessionId)?.controller.abort()
  }, [sessionId])
  return stop
}
