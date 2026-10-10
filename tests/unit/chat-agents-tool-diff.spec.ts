import { describe, expect, it } from 'vitest'
import { diffLines } from '../../samples/chat-agents/backend/src/tools.ts'

function words(maxLength: number): string[] {
  const values = ['']
  let level = ['']
  for (let length = 1; length <= maxLength; length++) {
    level = level.flatMap(prefix => ['a', 'b'].map(letter => prefix === '' ? letter : `${prefix}\n${letter}`))
    values.push(...level)
  }
  return values
}

describe('sample tool diff previews', () => {
  it('preserves both texts across repeated lines, empty files and every short binary sequence', () => {
    const corpus = words(5)
    for (const before of corpus) {
      for (const after of corpus) {
        const diff = diffLines(before, after)
        expect(diff.filter(line => line.kind !== 'add').map(line => line.text).join('\n')).toBe(before)
        expect(diff.filter(line => line.kind !== 'del').map(line => line.text).join('\n')).toBe(after)
      }
    }
  })

  it('keeps deletion-first tie breaking when repeated lines have equally short edits', () => {
    expect(diffLines('a\nb\na', 'b\na\nb')).toEqual([
      { kind: 'del', text: 'a' }, { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'a' }, { kind: 'add', text: 'b' },
    ])
  })

  it('retains a trailing empty line and shows replacement as deletion followed by addition', () => {
    expect(diffLines('old\n', 'new\n')).toEqual([
      { kind: 'del', text: 'old' }, { kind: 'add', text: 'new' }, { kind: 'ctx', text: '' },
    ])
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('', '\n')).toEqual([{ kind: 'add', text: '' }, { kind: 'add', text: '' }])
  })
})
