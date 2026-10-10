import type { WireEvent } from '@chat-agents/backend'
import type { ChatNode } from '../types'
import { stamped } from './stamp'

export function question(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'question'
}>): readonly ChatNode[] {
  return [...nodes, stamped({
      kind: 'question' as const,
      id: event.requestId,
      requestId: event.requestId,
      questions: event.questions,
      answered: false,
    })]
}

export function questionAnswered(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'question-answered'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'question' && node.requestId === event.requestId)
  if (index === -1)
    return nodes
  const next = [...nodes]
  next[index] = { ...(nodes[index] as Extract<ChatNode, {
      kind: 'question'
    }>), answered: true }
  return next
}

export function approval(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'approval'
}>): readonly ChatNode[] {
  const { t, member, ...approval } = event
  void t
  // A reload re-renders the same pending prompt from the live broker, so
  // an id already on screen is refreshed rather than duplicated.
  const index = nodes.findIndex(node => node.kind === 'approval' && node.callId === event.callId)
  const node = stamped({
    kind: 'approval' as const,
    id: event.callId,
    ...approval,
    ...member === undefined ? {} : { member },
  })
  if (index === -1)
    return [...nodes, node]
  const next = [...nodes]
  next[index] = node
  return next
}

export function approvalResolved(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'approval-resolved'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'approval' && node.callId === event.callId)
  if (index === -1)
    return nodes
  const next = [...nodes]
  next[index] = {
    ...(nodes[index] as Extract<ChatNode, {
      kind: 'approval'
    }>),
    decision: event.decision,
    scope: event.scope,
    ...event.ruleKey === undefined ? {} : { ruleKey: event.ruleKey },
  }
  return next
}

export function notice(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'notice'
}>): readonly ChatNode[] {
  return [...nodes, stamped({
      kind: 'notice' as const,
      id: `n_${String(nodes.length)}`,
      level: event.level,
      message: event.message,
      ...(event.member === undefined ? {} : { member: event.member }),
    })]
}

export function error(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'error'
}>): readonly ChatNode[] {
  return [...nodes, stamped({
      kind: 'error' as const,
      id: `e_${String(nodes.length)}`,
      message: event.message,
    })]
}
