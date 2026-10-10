import type { WireEvent } from '@chat-agents/backend'
import type { ChatNode } from '../types'
import { stamped } from './stamp'
const LIVE_OUTPUT_CAP = 20000

export function toolCall(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'tool-call'
}>): readonly ChatNode[] {
  return [...nodes, stamped({
      kind: 'tool' as const,
      id: event.id,
      name: event.name,
      args: event.args,
      state: 'running' as const,
      ...event.member === undefined ? {} : { member: event.member },
    })]
}

export function toolOutput(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'tool-output'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'tool' && node.id === event.id)
  if (index === -1)
    return nodes
  const current = nodes[index] as Extract<ChatNode, {
    kind: 'tool'
  }>
  const next = [...nodes]
  // Capped from the front: a long build's tail is what a watcher needs,
  // and the settled result carries the server's own capped copy anyway.
  const grown = (current.liveOutput ?? '') + event.chunk
  next[index] = { ...current, liveOutput: grown.slice(-LIVE_OUTPUT_CAP) }
  return next
}

export function toolResult(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'tool-result'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'tool' && node.id === event.id)
  if (index === -1)
    return nodes
  const current = nodes[index] as Extract<ChatNode, {
    kind: 'tool'
  }>
  const next = [...nodes]
  next[index] = {
    ...stamped(current),
    state: toolState(event),
    ...event.shortened === undefined ? {} : { shortened: event.shortened },
    output: event.output,
    ...event.card === undefined ? {} : { card: event.card },
    ...event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage },
  }
  return next
}
function toolState(event: Extract<WireEvent, {
  t: 'tool-result'
}>): 'declined' | 'ok' | 'error' {
  if (!event.ok)
    return 'error'
  return event.declined === true ? 'declined' : 'ok'
}
