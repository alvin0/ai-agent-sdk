/**
 * Property tests for the Chat Completions stream translator, text path.
 *
 * Feature: github-copilot-provider — Property 37.
 *
 * The generators are seeded rather than random, so any failure reproduces from
 * the printed seed; the repository carries no property-testing library, so they
 * live here alongside the property they serve.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import type { UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type {
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from '../../packages/protocol-openai-chat-completions/src/contract.ts'
import { translateChatCompletionsStream } from '../../packages/protocol-openai-chat-completions/src/translate.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Rng = () => number

function intBelow(rng: Rng, bound: number): number {
  return Math.floor(rng() * bound)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

/**
 * Answer text carrying the characters that break naive fragmentation.
 *
 * Every piece here is either multi-byte in UTF-8 (`ở`, `🌤`) or significant to
 * JSON encoding (`"`, `\n`, `\t`), because a fragment boundary landing inside
 * one of them is the whole point of this property.
 */
function answerText(rng: Rng): string {
  const words = [
    'Thời tiết', 'ở', 'Hà Nội', 'hôm nay', 'nắng nhẹ 🌤', '22°C',
    'line\nbreak', '"quoted"', 'tab\there', 'plain', '👨‍👩‍👧‍👦', 'ẫ', 'ﬄ',
  ]
  const count = 1 + intBelow(rng, 8)
  return Array.from({ length: count }, () => pick(rng, words)).join(' ')
}

/**
 * Cut a string into fragments at arbitrary UTF-16 code-unit boundaries.
 *
 * Boundaries are deliberately NOT snapped to code points, so a cut can land
 * between the halves of a surrogate pair — the UTF-16 face of a fragment split
 * in the middle of a multi-byte UTF-8 character. `JSON.stringify` escapes the
 * resulting lone surrogate, `JSON.parse` restores it, and only concatenation
 * puts the character back together; anything that inspects a fragment on its
 * own sees a broken character here.
 */
function fragment(value: string, rng: Rng): string[] {
  const cuts = new Set<number>()
  const wanted = intBelow(rng, value.length + 2)
  for (let i = 0; i < wanted; i += 1) cuts.add(intBelow(rng, value.length + 1))
  const bounds = [0, ...[...cuts].sort((left, right) => left - right), value.length]
  const pieces: string[] = []
  for (let i = 1; i < bounds.length; i += 1) {
    // Zero-length pieces are kept: an endpoint really does send `content: ""`,
    // and the translator must not open a block or emit a delta for one.
    pieces.push(value.slice(bounds[i - 1], bounds[i]))
  }
  return pieces
}

// ---------------------------------------------------------------------------
// Wire construction
// ---------------------------------------------------------------------------

const WIRE_FINISH = ['stop', 'length', 'content_filter'] as const
type WireFinish = typeof WIRE_FINISH[number]

/** The usage report an endpoint may or may not send. */
interface UsageReport {
  readonly prompt: number
  readonly completion: number
  readonly cached: number
}

function chunkEvent(body: unknown): ProtocolSseEvent {
  return { event: undefined, data: JSON.stringify(body) }
}

function choiceEvent(delta: unknown, finish: WireFinish | null): ProtocolSseEvent {
  return chunkEvent({
    id: 'chatcmpl-prop37',
    object: 'chat.completion.chunk',
    created: 1_718_203_040,
    model: 'gpt-4o',
    // A `null` usage on every non-final chunk is normal traffic and must not be
    // mistaken for a report.
    usage: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  })
}

function usageEvent(report: UsageReport): ProtocolSseEvent {
  return chunkEvent({
    id: 'chatcmpl-prop37',
    object: 'chat.completion.chunk',
    // The usage chunk arrives after the terminal finish and carries no choices.
    choices: [],
    usage: {
      prompt_tokens: report.prompt,
      completion_tokens: report.completion,
      total_tokens: report.prompt + report.completion,
      prompt_tokens_details: { cached_tokens: report.cached },
    },
  })
}

/** The SDK counters the report must become, per the disjoint-count convention. */
function expectedUsage(report: UsageReport): UsageCounters {
  return {
    outputTokens: report.completion,
    totalTokens: report.prompt + report.completion,
    ...report.cached === 0 ? {} : { cacheReadTokens: report.cached },
    // `prompt_tokens` is the TOTAL input and the cached figure is a subset of
    // it, so the cached portion comes back out to keep the three inputs disjoint.
    inputTokens: report.prompt - report.cached,
  } as UsageCounters
}

async function* streamOf(events: readonly ProtocolSseEvent[]): AsyncIterable<ProtocolSseEvent> {
  for (const event of events) yield event
}

async function collect(events: readonly ProtocolSseEvent[]): Promise<ProtocolStreamChunk[]> {
  const chunks: ProtocolStreamChunk[] = []
  for await (const chunk of translateChatCompletionsStream(streamOf(events), 'test')) {
    chunks.push(chunk)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Chunk inspection
// ---------------------------------------------------------------------------

function textDeltas(chunks: readonly ProtocolStreamChunk[]): string[] {
  return chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : [])
}

function ofType<T extends ProtocolStreamChunk['type']>(
  chunks: readonly ProtocolStreamChunk[],
  type: T,
): Extract<ProtocolStreamChunk, { type: T }>[] {
  return chunks.filter(
    (chunk): chunk is Extract<ProtocolStreamChunk, { type: T }> => chunk.type === type,
  )
}

/** The finish the wire reason must map onto. */
function expectedFinish(reason: WireFinish): unknown {
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'stop') return { kind: 'stop' }
  return {
    kind: 'error',
    failure: {
      message: 'the endpoint filtered this response',
      code: MODEL_ERROR_CODES.INVALID_REQUEST,
    },
  }
}

// ---------------------------------------------------------------------------
// Property 37
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 37: Stream SSE dịch thành chuỗi chunk trung thực', () => {
  it('rejoins every fragmentation of the text, finishes exactly once, and reports usage only when the endpoint does', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const text = answerText(rng)
      const pieces = fragment(text, rng)
      const reason = pick(rng, WIRE_FINISH)
      const report: UsageReport | undefined = bool(rng)
        ? {
            prompt: 10 + intBelow(rng, 5_000),
            completion: 1 + intBelow(rng, 900),
            cached: bool(rng) ? intBelow(rng, 10) : 0,
          }
        : undefined
      const trace = `seed ${String(seed)} pieces ${String(pieces.length)} finish ${reason}`

      const chunks = await collect([
        // The opening chunk announces the role and carries no text.
        choiceEvent({ role: 'assistant', content: '' }, null),
        ...pieces.map(piece => choiceEvent({ content: piece }, null)),
        choiceEvent({}, reason),
        ...report === undefined ? [] : [usageEvent(report)],
        { event: undefined, data: '[DONE]' },
      ])

      // Faithful text: the deltas rejoin to the original, byte for byte, with no
      // fragment lost, reordered, or repaired into a replacement character.
      expect(textDeltas(chunks).join(''), trace).toBe(text)
      expect(textDeltas(chunks).join(''), trace).not.toContain('\uFFFD')

      const starts = ofType(chunks, 'block-start')
      const ends = ofType(chunks, 'block-end')
      expect(starts.map(chunk => chunk.blockType), trace).toEqual(['text'])
      expect(ends.map(chunk => chunk.block), trace).toEqual([{ type: 'text', text }])
      // One block, opened before its first delta and closed after its last.
      const blockIndex = starts[0]?.index
      expect(new Set(ofType(chunks, 'text-delta').map(chunk => chunk.index)), trace)
        .toEqual(new Set([blockIndex]))
      expect(chunks.indexOf(starts[0] as ProtocolStreamChunk), trace).toBe(0)

      // Exactly one finish, last in the stream, carrying the mapped reason.
      const finishes = ofType(chunks, 'finish')
      expect(finishes.length, trace).toBe(1)
      expect(chunks.at(-1), trace).toBe(finishes[0])
      expect(finishes[0]?.reason, trace).toEqual(expectedFinish(reason))

      // Usage appears if and only if the endpoint supplied it.
      const usages = ofType(chunks, 'usage')
      expect(usages.length, trace).toBe(report === undefined ? 0 : 1)
      if (report !== undefined) expect(usages[0]?.usage, trace).toEqual(expectedUsage(report))
    }
  })

  it('emits no text block at all when every fragment is empty', async () => {
    // An answer that is genuinely empty must not produce a zero-length text
    // block: a block-start with nothing in it reads downstream as a real answer.
    const chunks = await collect([
      choiceEvent({ role: 'assistant', content: '' }, null),
      choiceEvent({ content: '' }, null),
      choiceEvent({}, 'stop'),
      { event: undefined, data: '[DONE]' },
    ])
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('rejoins recorded traffic fragmented mid-character at the byte level', async () => {
    // The generated cases cut UTF-16 strings; this one cuts UTF-8 BYTES of a real
    // recorded body, which is the fragmentation an HTTP transport actually
    // delivers, and reassembles the events with a streaming decoder.
    const path = new URL(
      '../../packages/protocol-openai-chat-completions/fixtures/text-stream.txt',
      import.meta.url,
    )
    const bytes = readFileSync(path)
    const expectedText = 'Thời tiết ở Hà Nội hôm nay nắng nhẹ 🌤.'

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const decoder = new TextDecoder('utf-8')
      let pending = ''
      const events: ProtocolSseEvent[] = []
      let offset = 0
      while (offset < bytes.length) {
        const size = 1 + intBelow(rng, 64)
        // `stream: true` is what makes a cut inside a multi-byte sequence
        // survive: the trailing bytes are held until the next fragment arrives.
        pending += decoder.decode(bytes.subarray(offset, offset + size), { stream: true })
        offset += size
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data:')) events.push({ event: undefined, data: line.slice(5) })
        }
      }
      pending += decoder.decode()
      if (pending.startsWith('data:')) events.push({ event: undefined, data: pending.slice(5) })

      const chunks = await collect(events)
      const trace = `seed ${String(seed)}`
      expect(textDeltas(chunks).join(''), trace).toBe(expectedText)
      expect(ofType(chunks, 'block-end').map(chunk => chunk.block), trace)
        .toEqual([{ type: 'text', text: expectedText }])
      expect(ofType(chunks, 'finish').length, trace).toBe(1)
      // This recording carries no usage chunk, so no usage may be invented.
      expect(ofType(chunks, 'usage').length, trace).toBe(0)
    }
  })
})
