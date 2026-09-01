import { describe, expect, it } from 'vitest'
import { BlockAssembler } from '../../src/core/stream/assembler.ts'
import type { StreamChunk } from '../../src/core/stream/chunk.ts'
import { ToolCallId } from '../../src/core/primitives/brand.ts'

const source = { kind: 'model', provider: 'p', model: 'm' } as const

function feed(chunks: readonly StreamChunk[]): BlockAssembler {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

describe('BlockAssembler', () => {
  it('assembles text from deltas with no block-start', () => {
    // Tolerating delta-only protocols matters: not every provider announces a
    // block before streaming into it.
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'llo' },
    ])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('preserves first-seen order rather than sorting indexes', () => {
    const assembler = feed([
      { type: 'text-delta', index: 5, text: 'first' },
      { type: 'text-delta', index: 1, text: 'second' },
    ])
    expect(assembler.blocks().map(b => (b.type === 'text' ? b.text : ''))).toEqual([
      'first',
      'second',
    ])
  })

  it('treats block-end as authoritative over accumulated deltas', () => {
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'authoritative' } },
    ])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'authoritative' }])
  })

  it('ignores deltas that arrive after a block closed', () => {
    // A misbehaving adapter must not be able to corrupt a block a consumer has
    // already been told is final, nor grow memory without bound.
    const assembler = feed([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'text-delta', index: 0, text: ' straggler' },
    ])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'done' }])
  })

  it('keeps the first block-end when a second arrives', () => {
    const assembler = feed([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'first' } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'second' } },
    ])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'first' }])
  })

  it('drops tool calls when the response hit the token cap', () => {
    // A call truncated mid-arguments has incomplete JSON; executing it would act
    // on arguments the model never finished choosing.
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'thinking out loud' },
      {
        type: 'tool-call-delta',
        index: 1,
        id: ToolCallId('call_1'),
        name: 'search',
        argumentsDelta: '{"q":"unfin',
      },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'thinking out loud' }])
  })

  it('keeps tool calls on a normal stop', () => {
    const assembler = feed([
      {
        type: 'tool-call-delta',
        index: 0,
        id: ToolCallId('call_1'),
        name: 'search',
        argumentsDelta: '{"q":"x"}',
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
    ])
  })

  it('prunes replay entries in step with dropped blocks', () => {
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'kept' },
      { type: 'tool-call-delta', index: 1, id: ToolCallId('c'), name: 't', argumentsDelta: '{' },
      {
        type: 'finish',
        reason: { kind: 'max-tokens' },
        replayState: { response: { id: 'r' }, blocks: ['keep-me', 'drop-me'] },
      },
    ])
    expect(assembler.replayState).toEqual({ response: { id: 'r' }, blocks: ['keep-me'] })
  })

  it('discards a replay envelope whose entries do not align', () => {
    // A misaligned mapping is worse than none, because a caller cannot tell.
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'one' },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {}, blocks: ['a', 'b'] } },
    ])
    expect(assembler.replayState).toBeUndefined()
  })

  it('omits tool calls and blank text from an interrupted prefix', () => {
    const assembler = feed([
      { type: 'text-delta', index: 0, text: 'real content' },
      { type: 'text-delta', index: 1, text: '   ' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('c'), name: 't', argumentsDelta: '{}' },
    ])
    expect(assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'real content' }])
  })

  it('defaults the finish reason to stop', () => {
    expect(feed([]).finish).toEqual({ kind: 'stop' })
  })

  it('produces a frozen message so shared history cannot be rewritten', () => {
    const message = feed([{ type: 'text-delta', index: 0, text: 'hi' }]).message(source)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(message.role).toBe('assistant')
  })
})
