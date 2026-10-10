import type { WireEvent, WireSpan } from '@chat-agents/backend'
import type { ChatNode, MemberState } from '../types'
import { textDelta, textEnd, reasoningDelta } from './text-events'
import { toolCall, toolOutput, toolResult } from './tool-events'
import { question, questionAnswered, approval, approvalResolved, notice, error } from './control-events'
const handlers = {
  'text-delta': textDelta,
  'text-end': textEnd,
  'reasoning-delta': reasoningDelta,
  'tool-call': toolCall,
  'tool-output': toolOutput,
  'tool-result': toolResult,
  'question': question,
  'question-answered': questionAnswered,
  'approval': approval,
  'approval-resolved': approvalResolved,
  'notice': notice,
  'error': error,
}

export function reduce(nodes: readonly ChatNode[], event: WireEvent): readonly ChatNode[] {
  if (!Object.hasOwn(handlers, event.t))
    return nodes
  const handler = handlers[event.t as keyof typeof handlers] as (
    nodes: readonly ChatNode[], event: WireEvent
  ) => readonly ChatNode[]
  return handler(nodes, event)
}

export function reduceMembers(members: readonly MemberState[], event: WireEvent): readonly MemberState[] {
  const upsert = (name: string, patch: Partial<MemberState>): readonly MemberState[] => {
    const index = members.findIndex(member => member.name === name)
    if (index === -1)
      return [...members, { name, status: 'idle', toolCalls: 0, ...patch }]
    const next = [...members]
    next[index] = { ...members[index] as MemberState, ...patch }
    return next
  }
  switch (event.t) {
    case 'run-start':
      return event.members.map(name => ({ name, status: 'idle' as const, toolCalls: 0 }))
    case 'member-start':
      return upsert(event.member, { status: 'running' })
    case 'member-end':
      return upsert(event.member, { status: 'done' })
    case 'tool-call': {
      if (event.member === undefined)
        return members
      const current = members.find(member => member.name === event.member)
      return upsert(event.member, { status: 'running', toolCalls: (current?.toolCalls ?? 0) + 1 })
    }
    default:
      return members
  }
}

export function reduceSpans(spans: readonly WireSpan[], event: WireEvent): readonly WireSpan[] {
  if (event.t === 'run-start')
    return []
  if (event.t !== 'span')
    return spans
  const index = spans.findIndex(span => span.spanId === event.span.spanId)
  if (index === -1)
    return [...spans, event.span]
  const next = [...spans]
  next[index] = event.span
  return next
}
