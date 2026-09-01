import { describe, expect, it } from 'vitest'
import { History } from '../../src/agent/history/history.ts'
import { normalizeToolPairing } from '../../src/agent/history/normalize.ts'
import { createMessage, createTextMessage, createToolResultMessage } from '../../src/core/message/message.ts'
import { ToolCallId } from '../../src/core/primitives/brand.ts'

type MutableSnapshot = {
  version: number
  entries: Array<{
    seq: number
    event: Record<string, any>
    surfaceOp: any
  }>
}

function resumableSnapshot(): MutableSnapshot {
  const history = new History()
  const callId = ToolCallId('resume-read-1')
  const user = history.append({ kind: 'user', message: createTextMessage('Inspect the migration.') })
  const assistant = history.append({
    kind: 'assistant',
    message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"migration.ts"}' }],
    }),
  })
  history.append({ kind: 'tool-call', callId, name: 'read', rawArguments: '{"path":"migration.ts"}' })
  const resultMessage = createToolResultMessage({
    callId, content: [{ type: 'text', text: 'migration source' }], isError: false,
  })
  const result = history.append({
    kind: 'tool-result', callId, message: resultMessage,
    result: { isError: false, value: 'migration source', content: [{ type: 'text', text: 'migration source' }] },
  })
  const compactionId = 'compact-resume-1'
  history.append({
    kind: 'compaction-start', compactionId, trigger: 'pressure', at: '2026-08-30T00:00:00.000Z',
  })
  const targets = [user.seq, assistant.seq, result.seq]
  history.append({
    kind: 'compaction-summary', compactionId, summary: 'Inspect migration; continue editing.',
    shadowedSeqs: targets, estimatedTokensBefore: 200, estimatedTokensAfter: 60,
    provider: 'test', model: 'm', usage: { inputTokens: 200, outputTokens: 30 },
  })
  history.append(
    { kind: 'user', message: createTextMessage('Inspect migration; continue editing.') },
    { op: 'replace', from: user.seq, to: result.seq, targets },
  )
  history.append({
    kind: 'compaction-end', compactionId, status: 'completed', at: '2026-08-30T00:00:01.000Z',
    thresholdTokens: 150, estimatedNonCompactableTokens: 20,
  })
  return JSON.parse(JSON.stringify(history.snapshot())) as MutableSnapshot
}

describe('History', () => {
  it('keeps the transcript while replacing only the model-visible surface', () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('one') })
    history.append({ kind: 'user', message: createTextMessage('two') })
    history.append({ kind: 'user', message: createTextMessage('summary') }, { op: 'replace', from: 1, to: 2 })
    expect(history.entries()).toHaveLength(3)
    expect(history.messages().flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '')).toEqual(['summary'])
    expect(history.generation()).toBe(1)

    const restored = History.fromSnapshot(JSON.parse(JSON.stringify(history.snapshot())) as never)
    expect(restored.entries()).toEqual(history.entries())
    expect(Object.isFrozen(restored.entries()[0])).toBe(true)
  })

  it('keeps replacement position and supports exact targets across repeated compactions', () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('one') })
    history.append({ kind: 'user', message: createTextMessage('two') })
    history.append({ kind: 'user', message: createTextMessage('three') })
    const first = history.append(
      { kind: 'user', message: createTextMessage('summary one-two') },
      { op: 'replace', from: 1, to: 2, targets: [1, 2] },
    )
    history.append(
      { kind: 'user', message: createTextMessage('summary all') },
      { op: 'replace', from: 3, to: first.seq, targets: [first.seq, 3] },
    )

    expect(history.messages().flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)).toEqual(['summary all'])
    expect(history.surface().map(node => node.seq)).toEqual([5])
  })

  it('repairs missing results and drops results that precede their call', () => {
    const id = ToolCallId('call-1')
    const orphan = createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'too early' }], isError: false })
    const assistant = createMessage({
      role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
      content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }],
    })
    const normalized = normalizeToolPairing([orphan, assistant])
    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toBe(assistant)
    expect(normalized[1]?.source).toMatchObject({ kind: 'tool', callId: id })
    expect(normalized[1]?.content[0]).toMatchObject({ type: 'tool-result', isError: true })
  })

  it('restores a complete version-1 snapshot and preserves extensible message payloads', () => {
    const snapshot = resumableSnapshot()
    snapshot.entries[6]!.event.message.content = [{
      type: 'plugin-checkpoint', payload: { cursor: 7 },
    }]
    snapshot.entries[6]!.event.message.source = {
      kind: 'plugin-memory', namespace: 'example',
    }

    const restored = History.fromSnapshot(snapshot as never)

    expect(restored.entries()).toHaveLength(snapshot.entries.length)
    expect(restored.entries()[6]?.event).toMatchObject({
      kind: 'user',
      message: {
        source: { kind: 'plugin-memory' },
        content: [{ type: 'plugin-checkpoint', payload: { cursor: 7 } }],
      },
    })
  })

  it('allows an interrupted snapshot ending at compaction-start for crash recovery', () => {
    const snapshot = resumableSnapshot()
    snapshot.entries = snapshot.entries.slice(0, 5)

    expect(() => History.fromSnapshot(snapshot as never)).not.toThrow()
  })

  it.each<[
    name: string,
    mutate: (snapshot: MutableSnapshot) => void,
    expected: RegExp,
  ]>([
    ['missing event message', snapshot => { delete snapshot.entries[0]!.event.message }, /message must be an object/],
    ['missing message content', snapshot => { delete snapshot.entries[0]!.event.message.content }, /content must be an array/],
    ['missing message id', snapshot => { delete snapshot.entries[0]!.event.message.id }, /message\.id must be a non-empty string/],
    ['duplicate message id', snapshot => {
      snapshot.entries[3]!.event.message.id = snapshot.entries[0]!.event.message.id
    }, /duplicate message id/],
    ['missing tool-call event id', snapshot => { delete snapshot.entries[2]!.event.callId }, /tool-call\.callId must be a non-empty string/],
    ['duplicate tool-call event id', snapshot => {
      snapshot.entries[4]!.event = {
        kind: 'tool-call', callId: snapshot.entries[2]!.event.callId,
        name: 'read', rawArguments: '{}',
      }
    }, /duplicate tool-call event id/],
    ['duplicate tool-call block id', snapshot => {
      snapshot.entries[6]!.event.message.content = [{
        type: 'tool-call', id: 'resume-read-1', name: 'read', arguments: '{}',
      }]
    }, /duplicate tool call id/],
    ['duplicate native tool id', snapshot => {
      const native = { type: 'native-tool-call', id: 'native-1', name: 'web-search', content: [] }
      snapshot.entries[0]!.event.message.content = [native]
      snapshot.entries[6]!.event.message.content = [structuredClone(native)]
    }, /duplicate native tool id/],
    ['mismatched tool-result event id', snapshot => {
      snapshot.entries[3]!.event.callId = 'different-call'
    }, /source\.callId must match/],
    ['missing tool-result outcome tag', snapshot => {
      delete snapshot.entries[3]!.event.result.isError
    }, /result\.isError must be a boolean/],
    ['missing compaction summary payload', snapshot => {
      delete snapshot.entries[5]!.event.summary
    }, /summary must be a non-empty string/],
    ['duplicate compaction shadow target', snapshot => {
      snapshot.entries[5]!.event.shadowedSeqs = [1, 1]
    }, /shadowedSeqs must contain unique/],
    ['future compaction shadow target', snapshot => {
      snapshot.entries[5]!.event.shadowedSeqs = [1, 99]
    }, /shadowedSeqs must contain unique/],
    ['non-visible compaction shadow target', snapshot => {
      snapshot.entries[5]!.event.shadowedSeqs = [3]
    }, /references non-visible message/],
    ['growing compaction estimate', snapshot => {
      snapshot.entries[5]!.event.estimatedTokensAfter = 201
    }, /estimatedTokensAfter cannot exceed/],
    ['duplicate compaction id', snapshot => {
      snapshot.entries[7]!.event = {
        kind: 'compaction-start', compactionId: 'compact-resume-1',
        trigger: 'manual', at: '2026-08-30T00:00:02.000Z',
      }
    }, /duplicate compaction id/],
    ['completed compaction without summary', snapshot => {
      snapshot.entries[5]!.event = structuredClone(snapshot.entries[7]!.event)
    }, /completed without a compaction-summary/],
    ['failed compaction without error', snapshot => {
      snapshot.entries[7]!.event.status = 'failed'
      delete snapshot.entries[7]!.event.error
    }, /error must be a non-empty string/],
    ['backoff without cooldown', snapshot => {
      snapshot.entries[7]!.event.backoffReason = 'low-savings'
    }, /backoffReason and cooldownSteps must be set together/],
    ['replacement targeting metadata', snapshot => {
      snapshot.entries[6]!.surfaceOp.targets = [3]
      snapshot.entries[6]!.surfaceOp.from = 3
    }, /replace targets must reference current visible messages/],
    ['replacement without message payload', snapshot => {
      snapshot.entries[6]!.event = {
        kind: 'compaction-prune', callId: 'resume-read-1', originalSeq: 4,
        charsBefore: 100, charsAfter: 20,
      }
    }, /replacement entry must carry a message/],
  ])('rejects corrupt snapshot: %s', (_name, mutate, expected) => {
    const snapshot = resumableSnapshot()
    mutate(snapshot)

    expect(() => History.fromSnapshot(snapshot as never)).toThrow(expected)
  })

  it('rejects invalid live appends without poisoning later valid history', () => {
    const history = new History()
    const message = createTextMessage('first')
    history.append({ kind: 'user', message })
    expect(() => history.append({ kind: 'user', message })).toThrow(/duplicate message id/)
    expect(() => history.append({ kind: 'user', message: createTextMessage('second') })).not.toThrow()
    expect(() => History.fromSnapshot(history.snapshot())).not.toThrow()
  })

  it('commits related history writes atomically', () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('first') })
    const duplicate = createTextMessage('duplicate within batch')
    expect(() => history.appendBatch([
      { event: { kind: 'user', message: duplicate } },
      { event: { kind: 'user', message: duplicate } },
    ])).toThrow(/duplicate message id/)
    expect(history.entries()).toHaveLength(1)
    expect(() => history.append({ kind: 'user', message: createTextMessage('still valid') })).not.toThrow()
  })

  it('enforces entry, cumulative byte, and entry-count limits', () => {
    const perEntry = new History({ maxEntries: 2, maxEntryBytes: 256, maxBytes: 512 })
    expect(() => perEntry.append({
      kind: 'user', message: createTextMessage('x'.repeat(1_000)),
    })).toThrow(/entry exceeds/)

    const count = new History({ maxEntries: 1, maxEntryBytes: 1_024, maxBytes: 1_024 })
    count.append({ kind: 'user', message: createTextMessage('one') })
    expect(() => count.append({ kind: 'user', message: createTextMessage('two') })).toThrow(/entry limit/)

    const cumulative = new History({ maxEntries: 10, maxEntryBytes: 400, maxBytes: 450 })
    cumulative.append({ kind: 'user', message: createTextMessage('a'.repeat(80)) })
    expect(() => cumulative.append({
      kind: 'user', message: createTextMessage('b'.repeat(200)),
    })).toThrow(/byte limit/)
  })

  it('rejects excessively nested content before recursive validation can overflow', () => {
    let block: Record<string, unknown> = { type: 'text', text: 'leaf' }
    for (let depth = 0; depth < 70; depth++) {
      block = { type: 'tool-result', toolCallId: 'nested', content: [block] }
    }
    const snapshot = {
      version: 1,
      entries: [{
        seq: 1, surfaceOp: 'append',
        event: {
          kind: 'user',
          message: {
            id: 'nested-message', role: 'user', source: { kind: 'user' }, content: [block],
          },
        },
      }],
    }
    expect(() => History.fromSnapshot(snapshot as never)).toThrow(/maximum content depth/)
  })
})
