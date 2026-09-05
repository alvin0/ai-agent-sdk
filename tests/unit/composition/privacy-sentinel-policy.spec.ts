import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const roots = Object.freeze([
  { directory: fileURLToPath(new URL('../../', import.meta.url)), label: 'tests' },
  { directory: fileURLToPath(new URL('../../../test-human/', import.meta.url)), label: 'test-human' },
])
const STRUCTURAL_BOUNDARY = /[/%~]/
const WHOLE_EVIDENCE_RECEIVER = /JSON\.stringify|serialized|report|diagnostics?|events?|health|record|receipt|snapshot|captured/i
const GENERATED_ID_ALPHABET = /^[A-Za-z0-9_-]+$/

describe('privacy assertion sentinel policy', () => {
  it('keeps literal private sentinels outside generated identifier alphabets', () => {
    const failures: string[] = []
    for (const root of roots) {
      for (const relative of readdirSync(root.directory, { recursive: true, encoding: 'utf8' })
        .filter(name => name.endsWith('.spec.ts'))) {
        const file = root.label + '/' + relative
        const source = readFileSync(root.directory + '/' + relative, 'utf8')
        for (const match of source.matchAll(/not\.toContain\((['"])([^'"]*PRIVATE[^'"]*)\1\)/g)) {
          const sentinel = match[2]!
          if (!STRUCTURAL_BOUNDARY.test(sentinel)) failures.push(file + ': ' + sentinel)
        }
        const constants = new Map<string, string>()
        for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]*)\2/g)) {
          constants.set(match[1]!, match[3]!)
        }
        for (const match of source.matchAll(/not\.toContain\(([A-Za-z_$][\w$]*)\)/g)) {
          const sentinel = constants.get(match[1]!)
          if (sentinel?.includes('PRIVATE') && !STRUCTURAL_BOUNDARY.test(sentinel)) {
            failures.push(file + ': ' + sentinel)
          }
        }
        if (/not\.toMatch\(\/[^/\n]*PRIVATE/.test(source)) failures.push(file + ': regex private sentinel')
        for (const line of source.split('\n')) {
          const match = line.match(/not\.toContain\((['"])([^'"]*)\1\)/)
          if (match !== null && WHOLE_EVIDENCE_RECEIVER.test(line)
            && match[2]!.length < 12 && GENERATED_ID_ALPHABET.test(match[2]!)) {
            failures.push(file + ': short whole-evidence substring ' + match[2])
          }
        }
      }
    }
    expect(failures).toEqual([])
  })
})
