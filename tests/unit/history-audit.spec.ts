import { describe, expect, it } from 'vitest'
import { createTextMessage } from '../../packages/core/src/message/index.ts'
import { History } from '../../packages/core/src/agent/history/history.ts'

describe('History large surfaces', () => {
  it('preserves unselected order and the first selected position across sparse replacements', () => {
    const history = new History()
    for (let index = 1; index <= 8; index++) {
      history.append({ kind: 'user', message: createTextMessage(String(index)) })
    }
    const first = history.append(
      { kind: 'user', message: createTextMessage('first summary') },
      { op: 'replace', from: 2, to: 8, targets: [8, 4, 2, 6] },
    )
    expect(history.surface().map(node => node.seq)).toEqual([1, first.seq, 3, 5, 7])
    const second = history.append(
      { kind: 'user', message: createTextMessage('second summary') },
      { op: 'replace', from: 3, to: first.seq, targets: [7, first.seq, 5] },
    )
    expect(history.surface().map(node => node.seq)).toEqual([1, second.seq, 3])
    history.append(
      { kind: 'user', message: createTextMessage('range summary') },
      { op: 'replace', from: 1, to: second.seq },
    )
    expect(history.messages()).toHaveLength(1)
    expect(history.messages()[0]?.content).toEqual([{ type: 'text', text: 'range summary' }])
  })

  it('commits and restores batches beyond the runtime function argument limit', () => {
    const count = 150_000
    const history = new History({ maxEntries: count + 1 })
    const message = createTextMessage('large batch')
    const writes = Array.from({ length: count }, (_, index) => ({
      event: { kind: 'user' as const, message: { ...message, id: `history-audit-${index}` as typeof message.id } },
    }))

    expect(history.appendBatch(writes)).toHaveLength(count)
    const restored = History.fromSnapshot(history.snapshot(), { maxEntries: count + 1 })
    expect(restored.entries()).toHaveLength(count)
    const appended = restored.append({ kind: 'user', message: createTextMessage('after restore') })
    expect(appended.seq).toBe(count + 1)
    expect(restored.messages()).toHaveLength(count + 1)
  }, 20_000)
})
