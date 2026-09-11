/**
 * Property test for stream termination in the Chat Completions translator.
 *
 * Feature: github-copilot-provider — Property 42.
 *
 * A truncated stream is byte-for-byte indistinguishable from a short answer, so
 * the only defence is the translator refusing to end normally without a
 * `finish_reason`. This suite cuts a generated stream at EVERY position before
 * that event and asserts the same stable error each time, plus the control
 * direction: the uncut stream does finish, so the property is not passing merely
 * because everything throws.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk } from '../../packages/protocol-openai-chat-completions/src/contract.ts'
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

/** Text with newlines, quotes and multi-byte characters — all wire-hostile. */
function text(rng: Rng): string {
  const words = ['Thời tiết', 'line\nbreak', '"quoted"', 'nắng nhẹ 🌤', 'tab\there', '22C']
  const count = 1 + intBelow(rng, 3)
  return Array.from({ length: count }, () => pick(rng, words)).join(' ')
}

/**
 * Cut a string into `parts` fragments at arbitrary code-UNIT boundaries.
 *
 * Deliberately not code-point aware: a real fragment can land between the two
 * halves of a surrogate pair or between the characters of a `\uXXXX` escape,
 * and the translator must survive that by concatenating rather than parsing.
 */
function splitInto(rng: Rng, value: string, parts: number): string[] {
  if (parts <= 1 || value.length === 0) return [value]
  const cuts = [...new Set(
    Array.from({ length: parts - 1 }, () => 1 + intBelow(rng, Math.max(1, value.length - 1))),
  )].sort((left, right) => left - right)
  const out: string[] = []
  let start = 0
  for (const cut of cuts) {
    out.push(value.slice(start, cut))
    start = cut
  }
  out.push(value.slice(start))
  return out
}

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

/**
 * One `data:` payload, tagged with where it sits relative to terminal finish.
 *
 * `pre` frames are the legal cut points: dropping everything from a `pre` frame
 * onward leaves a stream that never carried a finish reason.
 */
interface Frame {
  readonly phase: 'pre' | 'finish' | 'post'
  readonly data: string
}

const STREAM_ID = 'chatcmpl-terminal-property'

function chunkData(delta: unknown, finishReason: string | null): string {
  return JSON.stringify({
    id: STREAM_ID,
    object: 'chat.completion.chunk',
    created: 1_718_204_350,
    model: 'gpt-4o-2024-11-20',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  })
}

/** A `usage`-bearing chunk with no choices — normal traffic, not a malformed event. */
function usageData(): string {
  return JSON.stringify({
    id: STREAM_ID,
    object: 'chat.completion.chunk',
    created: 1_718_204_350,
    model: 'gpt-4o-2024-11-20',
    choices: [],
    usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 },
  })
}

/** A generated stream that IS complete, in frame order. */
interface Stream {
  readonly frames: readonly Frame[]
  /** Whether a tool call is in flight, which decides the finish reason. */
  readonly hasToolCall: boolean
}

function buildStream(rng: Rng): Stream {
  const pre: Frame[] = [{ phase: 'pre', data: chunkData({ role: 'assistant', content: '' }, null) }]

  // Text deltas: a fragmented answer, so cuts land between them.
  for (let i = 0; i < 1 + intBelow(rng, 4); i += 1) {
    for (const fragment of splitInto(rng, text(rng), 1 + intBelow(rng, 3))) {
      pre.push({ phase: 'pre', data: chunkData({ content: fragment }, null) })
    }
  }

  // Tool call: `id` and `name` once, then `arguments` in fragments, so cuts also
  // land between the fragments of a single JSON argument string.
  const hasToolCall = bool(rng)
  if (hasToolCall) {
    pre.push({
      phase: 'pre',
      data: chunkData({
        tool_calls: [{
          index: 0,
          id: `call_${String(intBelow(rng, 99_999))}`,
          type: 'function',
          function: { name: 'search_docs', arguments: '' },
        }],
      }, null),
    })
    const args = JSON.stringify({ query: text(rng), limit: 3 })
    for (const fragment of splitInto(rng, args, 2 + intBelow(rng, 4))) {
      pre.push({
        phase: 'pre',
        data: chunkData({ tool_calls: [{ index: 0, function: { arguments: fragment } }] }, null),
      })
    }
  }

  // Noise that is legal mid-stream and must not be mistaken for termination.
  if (bool(rng)) {
    pre.splice(1 + intBelow(rng, pre.length - 1), 0, {
      phase: 'pre',
      data: JSON.stringify({ id: STREAM_ID, choices: [], usage: null }),
    })
  }

  const frames: Frame[] = [
    ...pre,
    { phase: 'finish', data: chunkData({}, hasToolCall ? 'tool_calls' : 'stop') },
    ...bool(rng) ? [{ phase: 'post' as const, data: usageData() }] : [],
    { phase: 'post', data: '[DONE]' },
  ]
  return { frames, hasToolCall }
}

async function* eventsOf(frames: readonly string[]): AsyncIterable<ProtocolSseEvent> {
  for (const data of frames) yield { event: undefined, data }
}

/** Drain the translator, capturing whatever escaped before it threw. */
async function drain(frames: readonly string[]): Promise<{
  chunks: ProtocolStreamChunk[]
  error: unknown
}> {
  const chunks: ProtocolStreamChunk[] = []
  try {
    for await (const chunk of translateChatCompletionsStream(eventsOf(frames), 'test')) {
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    return { chunks, error }
  }
  return { chunks, error: undefined }
}

/** No result may escape as though the turn completed. */
function expectNoCompletion(chunks: readonly ProtocolStreamChunk[], trace: string): void {
  expect(chunks.map(chunk => chunk.type), trace).not.toContain('finish')
  expect(chunks.map(chunk => chunk.type), trace).not.toContain('usage')
  // A tool call is only released at the terminal finish, so a cut stream must
  // never hand the agent loop a call the model had not finished dictating.
  expect(chunks.map(chunk => chunk.type), trace).not.toContain('tool-call-delta')
}

// ---------------------------------------------------------------------------
// Property 42
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 42: Stream thiếu terminal finish là lỗi', () => {
  it('fails with a stable code at every cut position, and returns nothing as complete', async () => {
    /** Cut kinds actually exercised, asserted after the loop. */
    const covered = new Set<string>()
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 21_000)
      const { frames } = buildStream(rng)
      const preCount = frames.filter(frame => frame.phase === 'pre').length

      // Every prefix that stops short of the finish frame: `0` is "before the
      // first event", the rest land between text deltas, between `arguments`
      // fragments, and on either side of the mid-stream noise frames.
      const cut = intBelow(rng, preCount + 1)
      const prefix = frames.slice(0, cut).map(frame => frame.data)
      // The body may still have ended politely, with or without a trailing
      // sentinel, and `[DONE]` is not a finish reason.
      const tail: readonly string[] = pick<readonly string[]>(
        rng,
        [[], ['[DONE]'], ['[DONE]', '[DONE]'], ['']],
      )
      const trace = `seed ${String(seed)} cut ${String(cut)}/${String(preCount)} tail ${String(tail.length)}`

      covered.add(
        cut === 0
          ? 'before-first-event'
          : prefix.at(-1)?.includes('tool_calls') === true
            ? 'mid-arguments'
            : 'mid-text',
      )
      if (tail.includes('[DONE]')) covered.add('after-done')

      const { chunks, error } = await drain([...prefix, ...tail])
      expect(error, trace).toBeInstanceOf(ModelError)
      expect((error as ModelError).code, trace).toBe(MODEL_ERROR_CODES.STREAM_CLOSED)
      expectNoCompletion(chunks, trace)
    }

    // The property names four cut positions; a generator that quietly stopped
    // producing one of them would leave this suite green while covering less.
    expect([...covered].sort()).toEqual(
      ['after-done', 'before-first-event', 'mid-arguments', 'mid-text'],
    )
  })

  it('finishes the same streams once the terminal event is present', async () => {
    // The control direction. Without it, an implementation that threw on every
    // stream would satisfy the property above.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 21_000)
      const { frames, hasToolCall } = buildStream(rng)
      const trace = `seed ${String(seed)}`

      const { chunks, error } = await drain(frames.map(frame => frame.data))
      expect(error, trace).toBeUndefined()
      const finish = chunks.at(-1)
      expect(finish?.type, trace).toBe('finish')
      expect(finish, trace).toEqual({
        type: 'finish',
        reason: { kind: hasToolCall ? 'tool-calls' : 'stop' },
      })
    }
  })

  it('rejects every truncated fixture, whether or not the cut tail is delivered', async () => {
    const names = ['truncated-mid-delta.txt', 'truncated-mid-args.txt', 'done-without-finish.txt']
    for (const name of names) {
      const raw = await readFile(
        new URL(`../../packages/protocol-openai-chat-completions/fixtures/${name}`, import.meta.url),
        'utf8',
      )
      // SSE framing is spec-strict: an event dispatches on its blank-line
      // terminator, so a cut tail never reaches the translator.
      const payloads = raw
        .split('\n\n')
        .flatMap(block => block.split('\n'))
        .flatMap(line => line.startsWith('data:') ? [line.slice('data:'.length).trim()] : [])
      const complete = raw.endsWith('\n') ? payloads : payloads.slice(0, -1)

      const framed = await drain(complete)
      expect(framed.error, name).toBeInstanceOf(ModelError)
      expect((framed.error as ModelError).code, name).toBe(MODEL_ERROR_CODES.STREAM_CLOSED)
      expectNoCompletion(framed.chunks, name)

      // And a lenient decoder that did flush the half-written tail must still
      // fail — with a stable protocol code, never a quiet completion.
      const lenient = await drain(payloads)
      expect(lenient.error, `${name} lenient`).toBeInstanceOf(ModelError)
      expect(
        [MODEL_ERROR_CODES.STREAM_CLOSED, MODEL_ERROR_CODES.MALFORMED_RESPONSE],
        `${name} lenient`,
      ).toContain((lenient.error as ModelError).code)
      expectNoCompletion(lenient.chunks, `${name} lenient`)
    }
  })
})
