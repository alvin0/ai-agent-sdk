import type { WireEvent } from '@chat-agents/backend'
import type { ChatNode } from '../types'
import { stamped } from './stamp'

export function textDelta(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'text-delta'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'text' && node.id === event.id)
  if (index === -1) {
    return [...nodes, stamped({
        kind: 'text' as const,
        id: event.id,
        text: event.text,
        phase: event.phase,
        streaming: true,
        ...event.member === undefined ? {} : { member: event.member },
      })]
  }
  const current = nodes[index] as Extract<ChatNode, {
    kind: 'text'
  }>
  const next = [...nodes]
  next[index] = {
    ...current,
    text: current.text + event.text,
    // A phase is only known once the provider classifies the block; the
    // last classification for a block wins.
    phase: event.phase === 'unknown' ? current.phase : event.phase,
  }
  return next
}

export function textEnd(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'text-end'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'text' && node.id === event.id)
  if (index === -1)
    return event.text === undefined ? nodes : [...nodes, stamped({
        kind: 'text', id: event.id, text: event.text, phase: event.phase ?? 'unknown', streaming: false,
        ...event.incomplete ? { incomplete: true as const } : {},
        ...event.member === undefined ? {} : { member: event.member },
      })]
  const next = [...nodes]
  // Re-stamped as it closes: a turn ends when its last block finishes
  // streaming, not when its first delta arrived.
  next[index] = stamped({
    ...(nodes[index] as Extract<ChatNode, {
      kind: 'text'
    }>),
    ...event.text === undefined ? {} : { text: event.text },
    ...event.phase === undefined ? {} : { phase: event.phase },
    ...event.incomplete ? { incomplete: true as const } : {},
    streaming: false,
  })
  return next
}

export function reasoningDelta(nodes: readonly ChatNode[], event: Extract<WireEvent, {
  t: 'reasoning-delta'
}>): readonly ChatNode[] {
  const index = nodes.findIndex(node => node.kind === 'reasoning' && node.id === event.id)
  if (index === -1) {
    return [...nodes, stamped({
        kind: 'reasoning' as const,
        id: event.id,
        text: event.text,
        ...event.member === undefined ? {} : { member: event.member },
      })]
  }
  const current = nodes[index] as Extract<ChatNode, {
    kind: 'reasoning'
  }>
  const next = [...nodes]
  next[index] = { ...current, text: current.text + event.text }
  return next
}
