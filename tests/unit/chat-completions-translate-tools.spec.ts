/**
 * Property tests for tool-call accumulation in the Chat Completions translator.
 *
 * Feature: github-copilot-provider — Property 38.
 *
 * The three ways this translator can go wrong are all invisible to a
 * happy-path test, so the generator below aims squarely at them: keying the
 * accumulator on `id` (which arrives once) instead of `index` (which arrives on
 * every fragment), parsing `arguments` per fragment (a fragment can end inside
 * a JSON escape or between the halves of a surrogate pair), and releasing a
 * call before the finish reason says it is complete.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MODEL_ERROR_CODES, ModelError, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type {
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from '../../packages/protocol-openai-chat-completions/src/contract.ts'
import { translateChatCompletionsStream } from '../../packages/protocol-openai-chat-completions/src/translate.ts'
import type {
  WireFinishReason,
  WireStreamChunk,
  WireToolCallDelta,
} from '../../packages/protocol-openai-chat-completions/src/wire.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

const DISPLAY_NAME = 'Test Endpoint'

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

// ---------------------------------------------------------------------------
// Generated tool calls
// ---------------------------------------------------------------------------

/**
 * JSON values as the model would emit them, written as wire TEXT.
 *
 * `String.raw` matters: these carry LITERAL backslash-u escapes, so a cut
 * inside one produces a fragment that is not valid JSON on its own. The last
 * two carry real astral characters instead, so a cut can land between the
 * halves of a surrogate pair.
 */
const VALUE_TEXTS: readonly string[] = [
  String.raw`"H\u00e0 N\u1ed9i"`,
  String.raw`"a\nb\tc"`,
  String.raw`"\ud83c\udf24 \u00e9"`,
  String.raw`"quote \" and backslash \\"`,
  String.raw`{"nested":"\u00fc","deep":[1,2]}`,
  '1.50',
  'true',
  'null',
  '[1,2,3]',
  '"🌤 xin chào"',
  '"🙂🌤🎉🚀🧪🛰"',
]

const TOOL_NAMES = ['get_weather', 'get_time', 'lookup', 'run_query'] as const

/** One tool call the endpoint is pretending to make. */
interface GeneratedCall {
  /** The wire's `index`, the only key present on every fragment. */
  readonly wireIndex: number
  readonly id: string
  readonly name: string
  /** The complete `arguments` string, as the model produced it. */
  readonly args: string
  /** How that string was cut up on the way out. */
  readonly fragments: readonly string[]
}

function argumentsTextOf(rng: Rng, seed: number): string {
  const fields = Array.from(
    { length: 1 + intBelow(rng, 4) },
    (_unused, i) => `"k${String(i)}_${String(seed % 97)}":${pick(rng, VALUE_TEXTS)}`,
  )
  return `{${fields.join(',')}}`
}

/**
 * Cut a string at arbitrary code-unit boundaries.
 *
 * Code UNITS, not code points, on purpose: a cut between the halves of a
 * surrogate pair is exactly the case an implementation that decodes fragments
 * individually gets wrong. A leading empty fragment is also generated, because
 * the real API opens a tool call with `arguments: ""`.
 */
function fragmentsOf(rng: Rng, text: string): string[] {
  const cutCount = Math.min(intBelow(rng, 8), Math.max(text.length - 1, 0))
  const cuts = new Set<number>()
  while (cuts.size < cutCount) cuts.add(1 + intBelow(rng, text.length - 1))
  const bounds = [0, ...[...cuts].sort((left, right) => left - right), text.length]
  const fragments = bounds.slice(0, -1).map((start, i) => text.slice(start, bounds[i + 1]))
  return bool(rng) ? ['', ...fragments] : fragments
}

function generateCalls(rng: Rng, seed: number): GeneratedCall[] {
  return Array.from({ length: 1 + intBelow(rng, 3) }, (_unused, wireIndex) => {
    const args = argumentsTextOf(rng, seed + wireIndex)
    return {
      wireIndex,
      id: `call_${String(seed)}_${String(wireIndex)}`,
      name: pick(rng, TOOL_NAMES),
      args,
      fragments: fragmentsOf(rng, args),
    }
  })
}

// ---------------------------------------------------------------------------
// Scheduling fragments onto the wire
// ---------------------------------------------------------------------------

/** One `arguments` fragment on its way out, with the call it belongs to. */
interface Emission {
  readonly call: GeneratedCall
  readonly fragIndex: number
  readonly text: string
  /** Whether this fragment redundantly repeats `id` and `name`. */
  readonly repeatsIdentity: boolean
}

/**
 * Order the fragments, then group them into chunks.
 *
 * `interleaved` and `reversed` are the interesting orders. Interleaving proves
 * the accumulator correlates on `index` rather than on "the call currently
 * being built", and the reversed order makes first-seen order disagree with
 * wire-index order, which separates the block index from the wire index.
 */
function scheduleOf(rng: Rng, calls: readonly GeneratedCall[]): Emission[][] {
  const queues = calls.map(call =>
    call.fragments.map((text, fragIndex) => ({
      call,
      fragIndex,
      text,
      repeatsIdentity: fragIndex > 0 && rng() < 0.2,
    })))
  const order = pick(rng, ['sequential', 'reversed', 'interleaved'] as const)

  const flat: Emission[] = []
  if (order === 'interleaved') {
    for (let round = 0; flat.length < queues.reduce((sum, q) => sum + q.length, 0); round += 1) {
      for (const queue of queues) {
        const item = queue[round]
        if (item !== undefined) flat.push(item)
      }
    }
  } else {
    for (const queue of order === 'reversed' ? [...queues].reverse() : queues) flat.push(...queue)
  }

  // Batching: a single chunk is allowed to carry several `tool_calls` entries.
  const chunks: Emission[][] = []
  for (let i = 0; i < flat.length;) {
    const size = Math.min(1 + intBelow(rng, 2), flat.length - i)
    chunks.push(flat.slice(i, i + size))
    i += size
  }
  return chunks
}

function deltaOf(emission: Emission): WireToolCallDelta {
  const identity = emission.fragIndex === 0 || emission.repeatsIdentity
  return {
    index: emission.call.wireIndex,
    ...identity ? { id: emission.call.id, type: 'function' as const } : {},
    function: {
      ...identity ? { name: emission.call.name } : {},
      arguments: emission.text,
    },
  }
}

/** First-seen order of each call across the schedule, which is what fixes block indices. */
function firstSeenOrder(chunks: readonly Emission[][]): string[] {
  const seen: string[] = []
  for (const chunk of chunks) {
    for (const emission of chunk) {
      if (!seen.includes(emission.call.id)) seen.push(emission.call.id)
    }
  }
  return seen
}

// ---------------------------------------------------------------------------
// Wire assembly
// ---------------------------------------------------------------------------

function dataOf(chunk: WireStreamChunk): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1_718_203_411,
    model: 'test-model',
    ...chunk,
  })
}

function choiceChunk(delta: unknown, finish: WireFinishReason | null = null, index = 0): string {
  return dataOf({ choices: [{ index, delta: delta as never, finish_reason: finish }] })
}

/** The full event body, plus where the terminal finish sits in it. */
interface Wire {
  readonly datas: readonly string[]
  /** 1-based position of the finish event, compared against events consumed. */
  readonly finishAt: number
}

function wireOf(
  chunks: readonly Emission[][],
  finish: WireFinishReason,
  spokenText: readonly string[],
  foreignChoice: boolean,
): Wire {
  const datas: string[] = [choiceChunk({ role: 'assistant', content: null })]
  for (const piece of spokenText) datas.push(choiceChunk({ content: piece }))
  // A second choice must not reach the accumulator at all: its `index: 0`
  // fragment would otherwise splice a foreign call into the followed answer.
  if (foreignChoice) {
    datas.push(choiceChunk({
      tool_calls: [{
        index: 0,
        id: 'call_from_other_choice',
        type: 'function',
        function: { name: 'other', arguments: '{"leak":true}' },
      }],
    }, null, 1))
  }
  for (const chunk of chunks) datas.push(choiceChunk({ tool_calls: chunk.map(deltaOf) }))
  datas.push(choiceChunk({}, finish))
  const finishAt = datas.length
  datas.push(dataOf({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }))
  datas.push('[DONE]')
  return { datas, finishAt }
}

/** Tracks how many events the translator has pulled, so emission timing is observable. */
interface Feed {
  fed: number
}

async function* eventsOf(datas: readonly string[], feed: Feed): AsyncGenerator<ProtocolSseEvent> {
  for (const data of datas) {
    feed.fed += 1
    yield { event: undefined, data }
  }
}

// ---------------------------------------------------------------------------
// Chunk inspection
// ---------------------------------------------------------------------------

function isToolCallChunk(chunk: ProtocolStreamChunk): boolean {
  switch (chunk.type) {
    case 'tool-call-delta':
      return true
    case 'block-start':
      return chunk.blockType === 'tool-call'
    case 'block-end':
      return chunk.block.type === 'tool-call'
    default:
      return false
  }
}

/** The three chunks a completed tool call must produce, in order. */
function expectedToolCallChunks(call: GeneratedCall, index: number): ProtocolStreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index,
      id: ToolCallId(call.id),
      name: call.name,
      argumentsDelta: call.args,
    },
    {
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.args,
      },
    },
  ]
}

/**
 * Drain the translator, asserting on every chunk AS it arrives.
 *
 * The timing assertion has to happen here rather than over a collected array:
 * "only after the finish reason" is a claim about how far the input had been
 * read when the chunk came out, and that information is gone once the stream
 * has been fully consumed.
 */
async function drain(wire: Wire, trace: string): Promise<ProtocolStreamChunk[]> {
  const feed: Feed = { fed: 0 }
  const out: ProtocolStreamChunk[] = []
  for await (const chunk of translateChatCompletionsStream(eventsOf(wire.datas, feed), DISPLAY_NAME)) {
    if (isToolCallChunk(chunk)) {
      expect(feed.fed, `${trace} released a tool call after ${String(feed.fed)} events`)
        .toBeGreaterThanOrEqual(wire.finishAt)
    }
    out.push(chunk)
  }
  return out
}

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 38: Tool call tích lũy đúng và chỉ phát khi hoàn tất', () => {
  it('rejoins arguments exactly, keeps id and name, and releases nothing before the tool-call finish', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const calls = generateCalls(rng, seed)
      const chunks = scheduleOf(rng, calls)
      const spoken = bool(rng) ? ['thinking', ' about it'] : []
      const finish = pick(rng, ['tool_calls', 'function_call'] as const)
      const wire = wireOf(chunks, finish, spoken, bool(rng))
      const trace = `seed ${String(seed)} finish ${finish}`

      const produced = await drain(wire, trace)

      // Block indices are first-seen order and may disagree with wire order;
      // the emission order itself is by wire index.
      const seen = firstSeenOrder(chunks)
      const base = spoken.length > 0 ? 1 : 0
      const expected = [...calls]
        .sort((left, right) => left.wireIndex - right.wireIndex)
        .flatMap(call => expectedToolCallChunks(call, base + seen.indexOf(call.id)))

      expect(produced.filter(isToolCallChunk), trace).toEqual(expected)

      const finishes = produced.filter(chunk => chunk.type === 'finish')
      expect(finishes, trace).toEqual([{ type: 'finish', reason: { kind: 'tool-calls' } }])

      // Nothing from the unfollowed choice leaked in, at any depth.
      expect(JSON.stringify(produced), trace).not.toContain('call_from_other_choice')

      if (spoken.length > 0) {
        expect(produced.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text'), trace)
          .toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: spoken.join('') } })
      }
    }
  })

  it('withholds every accumulated fragment when the finish reason is not a tool-call one', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const calls = generateCalls(rng, seed)
      const chunks = scheduleOf(rng, calls)
      // `stop` contradicts the pending call and `length` truncated it; either
      // way the call never completed, so releasing it would hand the agent loop
      // a call the model never finished making.
      const finish = pick(rng, ['stop', 'length', 'content_filter'] as const)
      const wire = wireOf(chunks, finish, [], false)
      const trace = `seed ${String(seed)} finish ${finish}`

      const produced = await drain(wire, trace)

      expect(produced.filter(isToolCallChunk), trace).toEqual([])
      for (const call of calls) {
        expect(JSON.stringify(produced), `${trace} ${call.id}`).not.toContain(call.id)
      }
      expect(produced.filter(chunk => chunk.type === 'finish'), trace).toHaveLength(1)
    }
  })

  it('fails the stream when the rejoined arguments are not JSON, instead of emitting an empty call', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 7_000)
      const calls = generateCalls(rng, seed)
      const victim = pick(rng, calls)
      // A trailing comma after the closing brace: valid-looking per fragment,
      // and never valid once joined.
      const broken = calls.map(call =>
        call.id === victim.id
          ? { ...call, args: `${call.args},`, fragments: [...call.fragments, ','] }
          : call)
      const wire = wireOf(scheduleOf(rng, broken), 'tool_calls', [], false)
      const trace = `seed ${String(seed)}`

      const produced: ProtocolStreamChunk[] = []
      let thrown: unknown
      try {
        for await (const chunk of translateChatCompletionsStream(
          eventsOf(wire.datas, { fed: 0 }),
          DISPLAY_NAME,
        )) {
          produced.push(chunk)
        }
      } catch (error: unknown) {
        thrown = error
      }

      expect(thrown, trace).toBeInstanceOf(ModelError)
      expect((thrown as ModelError).code, trace).toBe(MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      // Not one call escaped: a partial release would leave the caller holding
      // some calls plus an error, with no way to tell which half to trust.
      expect(produced.filter(isToolCallChunk), trace).toEqual([])
      expect(produced.filter(chunk => chunk.type === 'finish'), trace).toEqual([])
    }
  })

  it('fails the stream when a fragment stream never carried an id and a name', async () => {
    const datas = [
      choiceChunk({ role: 'assistant', content: null }),
      // Arguments with no opening fragment: the call has no identity to report.
      choiceChunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      choiceChunk({}, 'tool_calls'),
      '[DONE]',
    ]
    await expect(async () => {
      for await (const _chunk of translateChatCompletionsStream(
        eventsOf(datas, { fed: 0 }),
        DISPLAY_NAME,
      )) { /* drained for the throw */ }
    }).rejects.toThrow(ModelError)
  })

  it('substitutes an empty object for a zero-parameter tool that sends no arguments', async () => {
    const datas = [
      choiceChunk({
        tool_calls: [{ index: 0, id: 'call_z', type: 'function', function: { name: 'ping', arguments: '' } }],
      }),
      choiceChunk({}, 'tool_calls'),
      '[DONE]',
    ]
    const produced: ProtocolStreamChunk[] = []
    for await (const chunk of translateChatCompletionsStream(eventsOf(datas, { fed: 0 }), DISPLAY_NAME)) {
      produced.push(chunk)
    }
    expect(produced.filter(isToolCallChunk)).toEqual(
      expectedToolCallChunks(
        { wireIndex: 0, id: 'call_z', name: 'ping', args: '{}', fragments: [''] },
        0,
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// Recorded traffic
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 38: recorded split-argument traffic', () => {
  it('reproduces the fixture stream, escapes and surrogate pairs intact', async () => {
    const body = await readFile(
      new URL(
        '../../packages/protocol-openai-chat-completions/fixtures/tool-call-split-args.txt',
        import.meta.url,
      ),
      'utf8',
    )
    const datas = body.split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())

    const produced: ProtocolStreamChunk[] = []
    for await (const chunk of translateChatCompletionsStream(eventsOf(datas, { fed: 0 }), DISPLAY_NAME)) {
      produced.push(chunk)
    }

    const weather = String.raw`{"city":"H\u00e0 N\u1ed9i","note":"a\nb","icon":"\ud83c\udf24","quote":"a\"b"}`
    expect(produced.filter(isToolCallChunk)).toEqual([
      ...expectedToolCallChunks(
        { wireIndex: 0, id: 'call_9Bp1kQx7', name: 'get_weather', args: weather, fragments: [] },
        0,
      ),
      ...expectedToolCallChunks(
        {
          wireIndex: 1,
          id: 'call_2Vf8nZa4',
          name: 'get_time',
          args: '{"tz":"Asia/Ho_Chi_Minh"}',
          fragments: [],
        },
        1,
      ),
    ])
    // The joined string is still the model's own bytes, so it parses.
    expect(JSON.parse(weather)).toEqual({ city: 'Hà Nội', note: 'a\nb', icon: '🌤', quote: 'a"b' })
    expect(produced.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(produced.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 142, outputTokens: 37, totalTokens: 179 },
    })
  })
})
