/**
 * Property tests for the Chat Completions serializer.
 *
 * Feature: github-copilot-provider — Property 36, 39, 40.
 *
 * Inputs are generated from a SEEDED generator rather than `Math.random`, so a
 * failure reproduces from the printed seed instead of vanishing on rerun. The
 * repository carries no property-testing library, so the generators live here.
 */

import { describe, expect, it } from 'vitest'
import {
  MODEL_ERROR_CODES,
  ModelError,
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@alvin0/ai-agent-sdk-core'
import type {
  GenerateOptions,
  JsonObject,
  Message,
  ModelOutputFormat,
  ResolvedModelInfo,
  ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from '../../packages/protocol-openai-chat-completions/src/contract.ts'
import { serializeChatCompletionsRequest } from '../../packages/protocol-openai-chat-completions/src/serialize.ts'
import {
  DEFAULT_DIALECT,
  type ChatCompletionsDialect,
} from '../../packages/protocol-openai-chat-completions/src/wire.ts'

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

/** Text with newlines, quotes, and multi-byte characters — all wire-hostile. */
function text(rng: Rng): string {
  const words = ['hi', 'xin chào', 'line\nbreak', '"quoted"', 'emoji 🙂', 'tab\there', '22C']
  const count = 1 + intBelow(rng, 3)
  return Array.from({ length: count }, () => pick(rng, words)).join(' ')
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

const model: ResolvedModelInfo = {
  provider: 'test',
  id: 'test-model',
  name: 'test-model',
  inputModalities: ['text', 'image'],
}

/**
 * A `ProtocolRequest` around the parts the serializer reads.
 *
 * Built locally rather than through `tests/unit/fixtures.ts`: that helper
 * returns a `provider-http` `ProviderRequest`, and this package must stay
 * buildable and testable knowing only `core` (DD-10).
 */
function chatRequest(
  options: Omit<GenerateOptions, 'provider' | 'model'>,
  maxTokens = 4_096,
): ProtocolRequest {
  return {
    options: { ...options, provider: 'test', model: model.id },
    model,
    maxTokens,
  }
}

function systemMessage(body: string): Message {
  return createMessage({
    role: 'system',
    content: [{ type: 'text', text: body }],
    source: { kind: 'app', producer: 'test' },
  })
}

const TOOL: ToolSchema = {
  name: 'lookup',
  description: 'look something up',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
}

// ---------------------------------------------------------------------------
// Wire inspection helpers
// ---------------------------------------------------------------------------

function keys(body: unknown): Record<string, unknown> {
  return body as Record<string, unknown>
}

function has(body: unknown, key: string): boolean {
  return Object.hasOwn(keys(body), key)
}

/** Every path holding `null` or `undefined`; a disabled flag must produce neither. */
function emptyValuePaths(value: unknown, path = 'body'): string[] {
  if (value === null || value === undefined) return [path]
  if (Array.isArray(value)) return value.flatMap((item, i) => emptyValuePaths(item, `${path}[${i}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => emptyValuePaths(child, `${path}.${key}`))
  }
  return []
}

// ---------------------------------------------------------------------------
// Property 36
// ---------------------------------------------------------------------------

/** One generated conversation turn, plus the wire messages it must become. */
type Turn =
  | { kind: 'system'; body: string }
  | { kind: 'user'; texts: string[] }
  | { kind: 'assistant'; texts: string[]; calls: { id: string; name: string; args: string }[] }
  | { kind: 'tool-result'; callId: string; body: string }

function generateTurns(rng: Rng): Turn[] {
  const count = 1 + intBelow(rng, 5)
  const turns: Turn[] = []
  for (let i = 0; i < count; i += 1) {
    switch (pick(rng, ['system', 'user', 'assistant', 'assistant', 'tool-result'] as const)) {
      case 'system': {
        turns.push({ kind: 'system', body: text(rng) })
        break
      }
      case 'user': {
        turns.push({
          kind: 'user',
          texts: Array.from({ length: 1 + intBelow(rng, 2) }, () => text(rng)),
        })
        break
      }
      case 'assistant': {
        const calls = Array.from({ length: intBelow(rng, 3) }, (_unused, index) => ({
          id: `call_${String(i)}_${String(index)}`,
          name: pick(rng, ['lookup', 'weather'] as const),
          // Deliberately unnormalized JSON: the serializer must replay it verbatim.
          args: `{ "q":  ${JSON.stringify(text(rng))}, "n": 1.50 }`,
        }))
        turns.push({
          kind: 'assistant',
          texts: Array.from({ length: intBelow(rng, 2) }, () => text(rng)),
          calls,
        })
        break
      }
      default: {
        turns.push({ kind: 'tool-result', callId: `call_r_${String(i)}`, body: text(rng) })
        break
      }
    }
  }
  return turns
}

function messagesOf(turns: readonly Turn[]): Message[] {
  return turns.map(turn => {
    switch (turn.kind) {
      case 'system':
        return systemMessage(turn.body)
      case 'user':
        return createUserMessage({
          content: turn.texts.map(body => ({ type: 'text' as const, text: body })),
          source: { kind: 'user' },
        })
      case 'assistant':
        return createAssistantMessage({
          content: [
            ...turn.texts.map(body => ({ type: 'text' as const, text: body })),
            ...turn.calls.map(call => ({
              type: 'tool-call' as const,
              id: ToolCallId(call.id),
              name: call.name,
              arguments: call.args,
            })),
          ],
          source: { provider: 'test', model: model.id },
        })
      default:
        return createToolResultMessage({
          callId: ToolCallId(turn.callId),
          content: [{ type: 'text', text: turn.body }],
          isError: false,
        })
    }
  })
}

/** The wire messages the turns must project onto, derived from the turns alone. */
function expectedMessages(
  turns: readonly Turn[],
  system: string | undefined,
  systemRole: 'system' | 'developer',
): unknown[] {
  const systemTexts = [
    ...system === undefined ? [] : [system],
    ...turns.flatMap(turn => turn.kind === 'system' && turn.body.length > 0 ? [turn.body] : []),
  ]
  const out: unknown[] = []
  if (systemTexts.length > 0) {
    out.push({ role: systemRole, content: systemTexts.join('\n\n') })
  }
  for (const turn of turns) {
    switch (turn.kind) {
      case 'system':
        break
      case 'user': {
        out.push({ role: 'user', content: turn.texts.join('\n') })
        break
      }
      case 'assistant': {
        const spoken = turn.texts.join('\n')
        if (spoken.length === 0 && turn.calls.length === 0) break
        out.push({
          role: 'assistant',
          ...spoken.length === 0 ? {} : { content: spoken },
          ...turn.calls.length === 0 ? {} : {
            tool_calls: turn.calls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.args },
            })),
          },
        })
        break
      }
      default: {
        out.push({ role: 'tool', tool_call_id: turn.callId, content: turn.body })
        break
      }
    }
  }
  return out
}

describe('Feature: github-copilot-provider, Property 36: Dịch request Chat Completions đầy đủ và đúng vai', () => {
  it('carries every message in order and role, with the dialect-chosen system role, token cap, and sampling', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const turns = generateTurns(rng)
      const system = bool(rng) ? text(rng) : undefined
      const temperature = bool(rng) ? Number((rng() * 2).toFixed(3)) : undefined
      const topP = bool(rng) ? Number(rng().toFixed(3)) : undefined
      const maxTokens = 16 + intBelow(rng, 8_000)
      const dialect: ChatCompletionsDialect = {
        ...DEFAULT_DIALECT,
        sampling: bool(rng),
        systemRole: pick(rng, ['system', 'developer'] as const),
        maxTokensField: pick(rng, ['max_tokens', 'max_completion_tokens', false] as const),
      }

      const body = serializeChatCompletionsRequest(
        chatRequest({
          messages: messagesOf(turns),
          ...system === undefined ? {} : { system },
          ...temperature === undefined ? {} : { temperature },
          ...topP === undefined ? {} : { topP },
        }, maxTokens),
        dialect,
      )
      const trace = `seed ${String(seed)}`

      expect(body.messages, trace).toEqual(expectedMessages(turns, system, dialect.systemRole))
      expect(body.model, trace).toBe(model.id)
      expect(body.stream, trace).toBe(true)

      // The cap lands in exactly the field the dialect names, and nowhere else.
      for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
        if (dialect.maxTokensField === field) expect(body[field], trace).toBe(maxTokens)
        else expect(has(body, field), `${trace} ${field}`).toBe(false)
      }

      const sampled = dialect.sampling
      expect(has(body, 'temperature'), trace).toBe(sampled && temperature !== undefined)
      expect(has(body, 'top_p'), trace).toBe(sampled && topP !== undefined)
      if (sampled && temperature !== undefined) expect(body.temperature, trace).toBe(temperature)
      if (sampled && topP !== undefined) expect(body.top_p, trace).toBe(topP)
    }
  })

  it('replays prior tool-call arguments byte-for-byte rather than re-encoding them', () => {
    // A `JSON.parse`/`JSON.stringify` round-trip reorders keys and renormalizes
    // `1.50` to `1.5`; some models read that exact string as their own context.
    const args = '{ "b": 1.50,\n  "a": "x" }'
    const body = serializeChatCompletionsRequest(chatRequest({
      messages: [createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'lookup', arguments: args }],
        source: { provider: 'test', model: model.id },
      })],
    }), DEFAULT_DIALECT)
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: args } }],
    })
  })
})

// ---------------------------------------------------------------------------
// Property 39
// ---------------------------------------------------------------------------

function generateSchema(rng: Rng): JsonObject {
  const names = Array.from({ length: 1 + intBelow(rng, 3) }, (_unused, i) => `f${String(i)}_${String(intBelow(rng, 99))}`)
  return {
    type: 'object',
    properties: Object.fromEntries(names.map(name => [
      name,
      { type: pick(rng, ['string', 'number', 'boolean'] as const) },
    ])),
    required: names,
    additionalProperties: false,
  }
}

describe('Feature: github-copilot-provider, Property 39: Structured output theo trạng thái dialect', () => {
  it('sends the exact schema when the flag is on and omits response_format when it is off', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 5_000)
      const schema = generateSchema(rng)
      const name = `answer_${String(intBelow(rng, 999))}`
      const format: ModelOutputFormat = { type: 'json_schema', name, schema }
      const state = pick(rng, ['json-schema', 'json-object', false] as const)
      const request = chatRequest({ messages: [createUserMessage({
        content: [{ type: 'text', text: text(rng) }],
        source: { kind: 'user' },
      })], outputFormat: format })
      const dialect: ChatCompletionsDialect = { ...DEFAULT_DIALECT, structuredOutputs: state }
      const trace = `seed ${String(seed)} state ${String(state)}`

      if (state === 'json-schema') {
        const body = serializeChatCompletionsRequest(request, dialect)
        expect(body.response_format, trace).toEqual({
          type: 'json_schema',
          json_schema: { name, schema, strict: true },
        })
        continue
      }

      if (state === 'json-object') {
        // JSON mode without a schema: valid JSON is guaranteed, this shape is not,
        // so the schema must not travel under a key the endpoint would ignore.
        const body = serializeChatCompletionsRequest(request, dialect)
        expect(body.response_format, trace).toEqual({ type: 'json_object' })
        expect(JSON.stringify(body), trace).not.toContain(Object.keys(
          schema['properties'] as Record<string, unknown>,
        )[0])
        continue
      }

      // Flag off with a schema requested: the caller is about to `JSON.parse` the
      // answer, so this fails loudly instead of silently downgrading to free text.
      let thrown: unknown
      try {
        serializeChatCompletionsRequest(request, dialect)
      } catch (error) {
        thrown = error
      }
      expect(thrown, trace).toBeInstanceOf(ModelError)
      expect((thrown as ModelError).code, trace).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)

      // And with no format requested at all, the key is simply absent.
      const plain = serializeChatCompletionsRequest(
        chatRequest({ messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'user' },
        })] }),
        dialect,
      )
      expect(has(plain, 'response_format'), trace).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 40: Cờ dialect tắt ⇒ trường vắng, một-một', () => {
  it('maps each flag one-to-one onto the presence of its wire field', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 9_000)
      const promptCacheKey = bool(rng) ? `pc_${String(intBelow(rng, 999))}` : undefined
      const dialect: ChatCompletionsDialect = {
        sampling: bool(rng),
        maxTokensField: pick(rng, ['max_tokens', 'max_completion_tokens', false] as const),
        structuredOutputs: pick(rng, ['json-schema', 'json-object', false] as const),
        tools: bool(rng),
        parallelToolCalls: bool(rng),
        streamUsage: bool(rng),
        systemRole: pick(rng, ['system', 'developer'] as const),
        stop: bool(rng),
        seed: bool(rng),
        reasoningEffort: bool(rng),
        ...promptCacheKey === undefined ? {} : { promptCacheKey },
        path: '/chat/completions',
      }

      // Every gated field is given a source, so absence can only come from a flag.
      const body = serializeChatCompletionsRequest(chatRequest({
        system: 'be terse',
        messages: [createUserMessage({
          content: [{ type: 'text', text: text(rng) }],
          source: { kind: 'user' },
        })],
        temperature: 0.4,
        topP: 0.9,
        stop: ['STOP'],
        reasoningEffort: ReasoningEffortId('medium'),
        tools: [TOOL],
        toolChoice: 'auto',
        // `text` rather than a schema: a schema with the flag off is a hard error
        // (Property 39), which would hide the presence/absence question here.
        outputFormat: { type: 'text' },
      }, 2_048), dialect)
      const trace = `seed ${String(seed)}`

      const expectations: readonly [string, boolean][] = [
        ['temperature', dialect.sampling],
        ['top_p', dialect.sampling],
        ['stop', dialect.stop],
        ['reasoning_effort', dialect.reasoningEffort],
        ['stream_options', dialect.streamUsage],
        ['tools', dialect.tools],
        ['tool_choice', dialect.tools],
        // Only meaningful alongside `tools`, and older gateways reject the bare key.
        ['parallel_tool_calls', dialect.tools && dialect.parallelToolCalls],
        ['response_format', dialect.structuredOutputs !== false],
        ['prompt_cache_key', promptCacheKey !== undefined],
        ['max_tokens', dialect.maxTokensField === 'max_tokens'],
        ['max_completion_tokens', dialect.maxTokensField === 'max_completion_tokens'],
        // `seed` has no source in `GenerateOptions`, so the flag cannot make the
        // field appear. The invariant that matters is the other direction: no
        // fabricated default is ever sent. Same for `user`, `frequency_penalty`
        // and `presence_penalty`.
        ['seed', false],
        ['user', false],
        ['frequency_penalty', false],
        ['presence_penalty', false],
      ]
      for (const [field, present] of expectations) {
        expect(has(body, field), `${trace} ${field}`).toBe(present)
      }

      // Absent means absent: not `null`, not `undefined`, at any depth.
      expect(emptyValuePaths(body), trace).toEqual([])
      expect(body.messages[0], trace).toEqual({ role: dialect.systemRole, content: 'be terse' })
    }
  })
})
