import { describe, expect, it } from 'vitest'
import { sanitizeObservationData } from '../../packages/core/src/observation/privacy.ts'

const marker = 'PRIVATE/FIXTURE~CONTENT%'

describe('recursive observation content redaction', () => {
  it('redacts each string inside a content container with its original path', () => {
    const visited: string[][] = []
    const result = sanitizeObservationData({ content: [marker, { nested: marker }], prompt: marker,
      metadata: 'preserved' }, { content: 'redacted', includeErrorStacks: false, redactors: [{
      id: 'fixture', redact(value, path) { visited.push([...path]); return value.replaceAll(marker, '[FILTERED]') },
    }] })
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(result.metadata).toBe('preserved')
    expect(visited).toEqual([
      ['data', 'content', '0'], ['data', 'content', '1', 'nested'], ['data', 'prompt'],
    ])
  })

  it('contains redactor failures inside nested content and still strips inline credentials', () => {
    const result = sanitizeObservationData({ content: [marker], note: 'Bearer fixture-token' }, {
      content: 'redacted', includeErrorStacks: false,
      redactors: [{ id: 'fixture', redact() { throw new Error('fixture failure') } }],
    })
    expect(result.content).toEqual(['[REDACTION_FAILED]'])
    expect(result.note).toBe('Bearer [REDACTED]')
  })

  it('preserves metadata and no-content policies for content containers', () => {
    const input = { content: [marker], note: 'preserved' }
    const common = { includeErrorStacks: false, redactors: [] }
    expect(sanitizeObservationData(input, { ...common, content: 'none' })).toEqual({ note: 'preserved' })
    expect(sanitizeObservationData(input, { ...common, content: 'metadata' })).toEqual({
      content: { kind: 'array', length: 1 }, note: 'preserved',
    })
  })
})
