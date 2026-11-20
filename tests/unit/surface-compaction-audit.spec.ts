import { describe, expect, it } from 'vitest'
import { createMessage, createTextMessage, createToolResultMessage,
  type Message } from '../../packages/core/src/message/index.ts'
import { ToolCallId } from '../../packages/core/src/primitives/index.ts'
import { selectCompactablePrefix } from '../../packages/core/src/agent/memory/surface-compaction.ts'
import { estimateMessageTokens } from '../../packages/core/src/agent/memory/token-estimator.ts'

function call(id: string): Message {
  return createMessage({
    role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
    content: [{ type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{}' }],
  })
}

function result(id: string): Message {
  return createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: 'done' }], isError: false })
}

function surface(messages: readonly Message[]) {
  return messages.map((message, index) => ({ seq: index + 1, message }))
}

function mixedMessage(random: (limit: number) => number): Message {
  const content = Array.from({ length: random(4) + 1 }, () => {
    const id = `pair-${random(8)}`
    switch (random(3)) {
      case 0: return call(id).content[0]!
      case 1: return result(id).content[0]!
      default: return { type: 'text' as const, text: 'context' }
    }
  })
  return createMessage({ role: 'user', source: { kind: 'user' }, content })
}

describe('compaction prefix pairing', () => {
  it('matches the former pairing scan for deterministic mixed surfaces', () => {
    let seed = 0x5417
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed % limit
    }
    for (let iteration = 0; iteration < 400; iteration++) {
      const messages = Array.from({ length: random(24) + 2 }, () => mixedMessage(random))
      const nodes = surface(messages)
      const total = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      for (const retainTokens of [1, random(total + 1), total + 1]) {
        expect(selectCompactablePrefix(nodes, retainTokens).length).toBe(legacyPrefixLength(messages, retainTokens))
      }
    }
  })

  it('retains a long call-result span as one unit', () => {
    const messages = [
      createTextMessage('original request'), call('long-span'),
      ...Array.from({ length: 10_000 }, () => createTextMessage('intermediate message')),
      result('long-span'),
    ]
    expect(selectCompactablePrefix(surface(messages), 1).map(node => node.seq)).toEqual([1])
  })

  it('moves across overlapping pair spans to the nearest balanced prefix', () => {
    const messages = [
      createTextMessage('original request'), call('a'), createTextMessage('intermediate'),
      call('b'), result('a'), result('b'), createTextMessage('latest request'),
    ]
    const retainTokens = estimateMessageTokens(messages.at(-1)) + 1
    expect(selectCompactablePrefix(surface(messages), retainTokens).map(node => node.seq)).toEqual([1])
    expect(selectCompactablePrefix(surface(messages), 1).map(node => node.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('keeps orphan results out of compactable prefixes', () => {
    const messages = [createTextMessage('original request'), result('missing'), createTextMessage('latest request')]
    expect(selectCompactablePrefix(surface(messages), 1)).toEqual([])
  })

  it('preserves pairing boundaries when a result precedes its call on the surface', () => {
    const messages = [
      createTextMessage('original request'), result('reordered'), createTextMessage('intermediate'),
      call('reordered'), createTextMessage('latest request'),
    ]
    const retainTokens = estimateMessageTokens(messages.at(-1)) + 1
    expect(selectCompactablePrefix(surface(messages), retainTokens).map(node => node.seq)).toEqual([1])
  })
})

function legacyPrefixLength(messages: readonly Message[], retainTokens: number): number {
  let accumulated = 0
  let split = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    accumulated += estimateMessageTokens(messages[index])
    split = index
    if (accumulated >= retainTokens) break
  }
  split = Math.max(1, Math.min(split, messages.length - 1))
  while (split > 0) {
    const sides = new Map<string, boolean>()
    messages.forEach((message, index) => {
      for (const block of message.content) {
        if (block.type === 'tool-call') sides.set(block.id, index < split)
      }
    })
    const balanced = messages.every((message, index) => message.content.every(block =>
      block.type !== 'tool-result' || sides.get(block.toolCallId) === (index < split)))
    if (balanced) break
    split--
  }
  return split
}
