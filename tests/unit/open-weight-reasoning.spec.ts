/**
 * Reasoning from OpenAI-compatible endpoints that are not OpenAI: vLLM,
 * llama.cpp, LM Studio, Ollama, OpenRouter, DeepSeek and gateways in front of
 * them. Covers both wires — Chat Completions (`reasoning_content`, `reasoning`,
 * leading `<think>` tags) and Responses (raw `reasoning_text` instead of an
 * encrypted blob) — on the way in and on replay.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_ERROR_CODES,
  withFailover,
  ModelError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
  createUserMessage,
} from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, GenerateOptions, Message, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import {
  serializeResponsesRequest,
  translateResponsesStream,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import type {
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from '../../packages/protocol-openai-chat-completions/src/contract.ts'
import { serializeChatCompletionsRequest } from '../../packages/protocol-openai-chat-completions/src/serialize.ts'
import { LeadingThinkSplitter } from '../../packages/protocol-openai-chat-completions/src/think-tags.ts'
import { translateChatCompletionsStream } from '../../packages/protocol-openai-chat-completions/src/translate.ts'
import { parseChatCompletionsErrorBody } from '../../packages/protocol-openai-chat-completions/src/errors.ts'
import { httpErrorCode, parseErrorBody } from '../../packages/provider-http/src/transport/errors.ts'
import {
  DEFAULT_DIALECT,
  type ChatCompletionsDialect,
  type WireMessage,
} from '../../packages/protocol-openai-chat-completions/src/wire.ts'
import { translateAnthropicStream } from '@alvin0/ai-agent-sdk-protocol-anthropic-messages'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'
import {
  chatCompletionsStreamError,
  isContentFilteredError,
} from '../../packages/protocol-openai-chat-completions/src/errors.ts'
import { providerRequest } from './fixtures.ts'

async function* sse(values: readonly object[]): AsyncIterable<ProtocolSseEvent> {
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}

async function collect(stream: AsyncIterable<ProtocolStreamChunk>): Promise<ProtocolStreamChunk[]> {
  const chunks: ProtocolStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function deltas(...pieces: readonly object[]): object[] {
  return [
    ...pieces.map(delta => ({ choices: [{ index: 0, delta }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
}

function endedBlocks(chunks: readonly ProtocolStreamChunk[]): ContentBlock[] {
  return chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
}

async function chatBlocks(...pieces: readonly object[]): Promise<ContentBlock[]> {
  return endedBlocks(await collect(translateChatCompletionsStream(sse(deltas(...pieces)), 'test')))
}

// ---------------------------------------------------------------------------
// Chat Completions: reading
// ---------------------------------------------------------------------------

describe('Chat Completions reasoning fields', () => {
  it('reads `reasoning_content` and remembers the field for replay', async () => {
    const blocks = await chatBlocks({ reasoning_content: 'think ' }, { reasoning_content: 'hard' }, { content: 'ok' })
    expect(blocks).toEqual([
      { type: 'reasoning', text: 'think hard', kind: 'content',
        providerState: { protocol: 'openai-chat-completions', field: 'reasoning_content' } },
      { type: 'text', text: 'ok' },
    ])
  })

  it('reads `reasoning` (OpenRouter, Ollama, newer vLLM)', async () => {
    const blocks = await chatBlocks({ reasoning: 'plan' }, { content: 'done' })
    expect(blocks[0]).toEqual({ type: 'reasoning', text: 'plan', kind: 'content',
      providerState: { protocol: 'openai-chat-completions', field: 'reasoning' } })
  })

  it('reads a delta carrying both spellings once, not twice', async () => {
    const blocks = await chatBlocks({ reasoning_content: 'same', reasoning: 'same' }, { content: 'x' })
    expect(blocks[0]).toMatchObject({ type: 'reasoning', text: 'same' })
  })
})

describe('Chat Completions leading <think> tags', () => {
  it('splits a think block out of content even when tags straddle fragments', async () => {
    const blocks = await chatBlocks(
      { content: '\n<thi' }, { content: 'nk>plan' }, { content: 'ning</th' }, { content: 'ink>\n\nAns' },
      { content: 'wer' },
    )
    expect(blocks).toEqual([
      { type: 'reasoning', text: 'planning', kind: 'content',
        providerState: { protocol: 'openai-chat-completions', field: 'think-tag' } },
      { type: 'text', text: 'Answer' },
    ])
  })

  it('leaves a tag that does not open the content as plain text', async () => {
    const blocks = await chatBlocks({ content: 'Use <think>' }, { content: 'x</think> tags' })
    expect(blocks).toEqual([{ type: 'text', text: 'Use <think>x</think> tags' }])
  })

  it('keeps content that merely starts with `<` intact', async () => {
    const blocks = await chatBlocks({ content: '<' }, { content: 'div>hi</div>' })
    expect(blocks).toEqual([{ type: 'text', text: '<div>hi</div>' }])
  })

  it('treats a think block cut off by the token limit as reasoning', async () => {
    const chunks = await collect(translateChatCompletionsStream(sse([
      { choices: [{ index: 0, delta: { content: '<think>still going' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]), 'test'))
    expect(endedBlocks(chunks)).toEqual([
      expect.objectContaining({ type: 'reasoning', text: 'still going' }),
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('streams reasoning before the close tag arrives, holding back only a possible tag prefix', () => {
    const splitter = new LeadingThinkSplitter()
    expect(splitter.push('<think>abc</')).toEqual([{ kind: 'reasoning', text: 'abc' }])
    expect(splitter.push('think>')).toEqual([])
    expect(splitter.push('\n\n  tail')).toEqual([{ kind: 'text', text: '  tail' }])
    expect(splitter.flush()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Chat Completions: replay
// ---------------------------------------------------------------------------

const MODEL: ResolvedModelInfo = { provider: 'test', id: 'test-model', name: 'test-model', inputModalities: ['text'] }
const SOURCE = { provider: 'test', model: 'test-model' }
/** What core keeps on a message while the history goes back to the endpoint that produced it. */
const CHAT_SOURCE = { ...SOURCE, replayState: { response: { protocol: 'openai-chat-completions' } } }

function chatRequest(options: Omit<GenerateOptions, 'provider' | 'model'>): ProtocolRequest {
  return { options: { ...options, provider: 'test', model: MODEL.id }, model: MODEL, maxTokens: 1_024 }
}

function chatDialect(reasoningReplay: NonNullable<ChatCompletionsDialect['reasoningReplay']>): ChatCompletionsDialect {
  return { ...DEFAULT_DIALECT, reasoningReplay }
}

function reasoning(text: string, providerState?: unknown): ContentBlock {
  return { type: 'reasoning', text, kind: 'content', ...providerState === undefined ? {} : { providerState } }
}

function toolTurn(id: string, thought: ContentBlock, source: typeof SOURCE = CHAT_SOURCE): Message[] {
  return [
    createAssistantMessage({ source, content: [
      thought,
      { type: 'tool-call', id: ToolCallId(id), name: 'lookup', arguments: '{}' },
    ] }),
    createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: 'result' }], isError: false }),
  ]
}

function assistantWire(messages: readonly Message[], replay: NonNullable<ChatCompletionsDialect['reasoningReplay']>)
  : Extract<WireMessage, { role: 'assistant' }>[] {
  return serializeChatCompletionsRequest(chatRequest({ messages: [...messages] }), chatDialect(replay)).messages
    .filter((message): message is Extract<WireMessage, { role: 'assistant' }> => message.role === 'assistant')
}

const OWN = (field: string, model = 'test-model') => ({ protocol: 'openai-chat-completions', field, model })

describe('Chat Completions reasoning replay', () => {
  it('defaults to auto', () => {
    expect(DEFAULT_DIALECT.reasoningReplay).toBe('auto')
  })

  it('auto: replays the current tool loop under the field it arrived on, never earlier turns', () => {
    const messages = [
      createTextMessage('first question'),
      ...toolTurn('call_old', reasoning('old thought', OWN('reasoning_content'))),
      createAssistantMessage({ source: CHAT_SOURCE, content: [{ type: 'text', text: 'first answer' }] }),
      createTextMessage('second question'),
      ...toolTurn('call_a', reasoning('thought a', OWN('reasoning_content'))),
      ...toolTurn('call_b', reasoning('thought b', OWN('reasoning'))),
    ]
    const wire = assistantWire(messages, 'auto')
    expect(wire).toHaveLength(4)
    expect(wire[0]).not.toHaveProperty('reasoning_content')
    expect(wire[2]).toMatchObject({ reasoning_content: 'thought a' })
    expect(wire[3]).toMatchObject({ reasoning: 'thought b' })
    expect(wire[3]).not.toHaveProperty('reasoning_content')
  })

  it('auto: does not replay reasoning from another provider or another model', () => {
    const messages = [
      createTextMessage('q'),
      ...toolTurn('call_a', reasoning('other model', OWN('reasoning_content', 'deepseek-other'))),
      ...toolTurn('call_b', reasoning('foreign', { id: 'rs_1', summary: ['foreign'] })),
      ...toolTurn('call_c', reasoning('unknown')),
      ...toolTurn('call_d', reasoning('no model', { protocol: 'openai-chat-completions', field: 'reasoning' })),
    ]
    for (const message of assistantWire(messages, 'auto')) {
      expect(message).not.toHaveProperty('reasoning_content')
      expect(message).not.toHaveProperty('reasoning')
      expect(message.content ?? '').not.toContain('<think>')
    }
  })

  it('auto: puts think-tag reasoning back inside content, where the chat template looks for it', () => {
    const messages = [createTextMessage('q'), createAssistantMessage({ source: CHAT_SOURCE, content: [
      reasoning('plan', OWN('think-tag')), { type: 'text', text: 'calling' },
      { type: 'tool-call', id: ToolCallId('call_a'), name: 'lookup', arguments: '{}' },
    ] }), createToolResultMessage({ callId: ToolCallId('call_a'), content: [{ type: 'text', text: 'r' }], isError: false })]
    const [wire] = assistantWire(messages, 'auto')
    expect(wire?.content).toBe('<think>plan</think>\n\ncalling')
    expect(wire).not.toHaveProperty('reasoning_content')
    const toolOnly = [createTextMessage('q'), ...toolTurn('call_b', reasoning('only', OWN('think-tag')))]
    expect(assistantWire(toolOnly, 'auto')[0]?.content).toBe('<think>only</think>\n\n')
  })

  it('auto: an application note mid-loop does not end the turn; a real user message does', () => {
    const note = createUserMessage({ source: { kind: 'app', producer: 'budget' }, content: [{ type: 'text', text: 'budget' }] })
    const loop = [
      createTextMessage('q'),
      ...toolTurn('call_a', reasoning('first', OWN('reasoning_content'))),
      note,
      ...toolTurn('call_b', reasoning('second', OWN('reasoning_content'))),
    ]
    expect(assistantWire(loop, 'auto').map(m => m.reasoning_content)).toEqual(['first', 'second'])
    const fresh = [...loop, createTextMessage('next question'), ...toolTurn('call_c', reasoning('third', OWN('reasoning_content')))]
    expect(assistantWire(fresh, 'auto').map(m => m.reasoning_content)).toEqual([undefined, undefined, 'third'])
  })

  it('auto: does not replay the same model id served by another endpoint (failover member)', () => {
    // Core strips the replay state of another member's messages; the block alone cannot tell hosts apart.
    const messages = [createTextMessage('q'), ...toolTurn('call_a', reasoning('member a', OWN('reasoning_content')), SOURCE)]
    expect(assistantWire(messages, 'auto')[0]).not.toHaveProperty('reasoning_content')
    expect(assistantWire(messages, 'reasoning_content')[0]).toMatchObject({ reasoning_content: 'member a' })
  })

  it('treats a dialect without reasoningReplay as auto', () => {
    const messages = [createTextMessage('q'), ...toolTurn('call_a', reasoning('t', OWN('reasoning_content')))]
    const { reasoningReplay: _omitted, ...dialect } = DEFAULT_DIALECT
    const [wire] = serializeChatCompletionsRequest(chatRequest({ messages }), dialect).messages
      .filter(message => message.role === 'assistant')
    expect(wire).toMatchObject({ reasoning_content: 't' })
  })

  it('a named field forces replay of any reasoning in the current turn; false never replays', () => {
    const messages = [createTextMessage('q'), ...toolTurn('call_a', reasoning('foreign'))]
    expect(assistantWire(messages, 'reasoning')[0]).toMatchObject({ reasoning: 'foreign' })
    expect(assistantWire(messages, 'reasoning_content')[0]).toMatchObject({ reasoning_content: 'foreign' })
    expect(assistantWire(messages, false)[0]).not.toHaveProperty('reasoning_content')
  })

  it('round-trips: what the translator read is exactly what the serializer sends back', async () => {
    const chunks = await collect(translateChatCompletionsStream(
      sse(deltas({ reasoning_content: 'need lookup' }, { content: 'checking' })), 'test', { model: 'test-model' },
    ))
    const blocks = endedBlocks(chunks)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ replayState: { response: { protocol: 'openai-chat-completions' } } })
    const plain = await collect(translateChatCompletionsStream(sse(deltas({ content: 'no thoughts' })), 'test'))
    expect(plain.find(chunk => chunk.type === 'finish')).not.toHaveProperty('replayState')
    const messages = [
      createTextMessage('q'),
      createAssistantMessage({ source: { ...SOURCE, replayState: finish?.type === 'finish' ? finish.replayState : undefined },
        content: [
        ...blocks, { type: 'tool-call', id: ToolCallId('call_1'), name: 'lookup', arguments: '{}' },
      ] }),
      createToolResultMessage({ callId: ToolCallId('call_1'), content: [{ type: 'text', text: 'r' }], isError: false }),
    ]
    expect(assistantWire(messages, 'auto')[0]).toEqual({
      role: 'assistant', reasoning_content: 'need lookup', content: 'checking',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    })
  })
})

// ---------------------------------------------------------------------------
// Responses: raw reasoning_text
// ---------------------------------------------------------------------------

const RESPONSES_DIALECT: ResponsesDialect = {
  sampling: true, maxOutputTokens: true, structuredOutputs: true, store: false,
  include: ['reasoning.encrypted_content'],
}

async function responsesBlocks(values: readonly object[]): Promise<ContentBlock[]> {
  const chunks = []
  for await (const chunk of translateResponsesStream(sse(values), 'test')) chunks.push(chunk)
  return chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
}

describe('Responses raw reasoning (vLLM, gpt-oss, DeepSeek gateways)', () => {
  it('keeps streamed reasoning_text as raw content on the block', async () => {
    const blocks = await responsesBlocks([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning', summary: [], content: [] } },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'step ' },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'one' },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [],
        content: [{ type: 'reasoning_text', text: 'step one' }] } },
      { type: 'response.completed', response: {} },
    ])
    expect(blocks).toEqual([{
      type: 'reasoning', text: 'step one', kind: 'content',
      providerState: { id: 'rs_1', content: ['step one'] },
    }])
  })

  it('recovers the text from the done item when no deltas were streamed', async () => {
    const blocks = await responsesBlocks([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'quiet thought' }] } },
      { type: 'response.completed', response: {} },
    ])
    expect(blocks[0]).toMatchObject({ type: 'reasoning', text: 'quiet thought', kind: 'content' })
  })

  it('replays raw reasoning as reasoning_text, not relabelled as a summary', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({ source: SOURCE, content: [
        { type: 'reasoning', text: 'step one', kind: 'content', providerState: { id: 'rs_1', content: ['step one'] } },
      ] })],
    }), RESPONSES_DIALECT)
    expect(body.input[0]).toEqual({
      type: 'reasoning', id: 'rs_1', summary: [],
      content: [{ type: 'reasoning_text', text: 'step one' }],
    })
  })

  it('replays a raw-content block stored before raw content was tracked the same way', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({ source: SOURCE, content: [
        { type: 'reasoning', text: 'older', kind: 'content', providerState: { id: 'rs_2' } },
      ] })],
    }), RESPONSES_DIALECT)
    expect(body.input[0]).toEqual({
      type: 'reasoning', id: 'rs_2', summary: [], content: [{ type: 'reasoning_text', text: 'older' }],
    })
  })

  it('leaves OpenAI-style encrypted reasoning exactly as before', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({ source: SOURCE, content: [
        { type: 'reasoning', text: 'sum', kind: 'summary',
          providerState: { id: 'rs_3', encryptedContent: 'opaque', summary: ['sum'] } },
      ] })],
    }), RESPONSES_DIALECT)
    expect(body.input[0]).toEqual({
      type: 'reasoning', id: 'rs_3', summary: [{ type: 'summary_text', text: 'sum' }], encrypted_content: 'opaque',
    })
  })
})

// ---------------------------------------------------------------------------
// Structured output misfiled as reasoning (vLLM reasoning parser + guided decoding)
// ---------------------------------------------------------------------------

const JSON_REQUEST = providerRequest({
  messages: [createTextMessage('capital as JSON')],
  outputFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
})

async function chatJson(jsonOutput: boolean, ...pieces: readonly object[]): Promise<ContentBlock[]> {
  return endedBlocks(await collect(translateChatCompletionsStream(sse(deltas(...pieces)), 'test', { jsonOutput })))
}

describe('JSON answer left in reasoning', () => {
  it('Chat Completions: emits the reasoning as the answer when JSON was requested and no text came', async () => {
    const blocks = await chatJson(true, { reasoning_content: ' {"capital":"Hanoi"} ' })
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '{"capital":"Hanoi"}' })
  })

  it('Chat Completions: leaves every other case alone', async () => {
    expect((await chatJson(false, { reasoning_content: '{"a":1}' })).map(b => b.type)).toEqual(['reasoning'])
    expect((await chatJson(true, { reasoning_content: 'thinking {"a":1}' })).map(b => b.type)).toEqual(['reasoning'])
    expect((await chatJson(true, { reasoning_content: '{"a":' })).map(b => b.type)).toEqual(['reasoning'])
    expect(await chatJson(true, { reasoning_content: '{"a":1}' }, { content: '{"a":2}' }))
      .toEqual([expect.objectContaining({ type: 'reasoning' }), { type: 'text', text: '{"a":2}' }])
  })

  it('Responses: emits the reasoning as the answer when JSON was requested and no message came', async () => {
    const chunks = []
    for await (const chunk of translateResponsesStream(sse([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: '{"capital":"Hanoi"}' },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning',
        content: [{ type: 'reasoning_text', text: '{"capital":"Hanoi"}' }] } },
      { type: 'response.completed', response: {} },
    ]), 'test', JSON_REQUEST)) chunks.push(chunk)
    expect(chunks.slice(-4)).toEqual([
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '{"capital":"Hanoi"}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '{"capital":"Hanoi"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('Responses: does nothing when JSON was not requested', async () => {
    const blocks = await responsesBlocks([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning',
        content: [{ type: 'reasoning_text', text: '{"a":1}' }] } },
      { type: 'response.completed', response: {} },
    ])
    expect(blocks.map(b => b.type)).toEqual(['reasoning'])
  })
})

// ---------------------------------------------------------------------------
// Gateway error bodies
// ---------------------------------------------------------------------------

describe('gateway error bodies with a description', () => {
  const body = JSON.stringify({ code: 400, message: 'Bad request', description: 'Invalid image URL', subcode: 400000 })

  it('keeps the real reason from `description` in both parsers, identically', () => {
    expect(parseErrorBody(body)).toEqual({ message: 'Bad request: Invalid image URL', detail: 'Bad request Invalid image URL' })
    expect(parseChatCompletionsErrorBody(body)).toEqual(parseErrorBody(body))
  })

  it('uses `description` alone when there is no message, and never repeats it', () => {
    expect(parseErrorBody(JSON.stringify({ description: 'quota' })).message).toBe('quota')
    expect(parseErrorBody(JSON.stringify({ message: 'same', description: 'same' })).message).toBe('same')
    expect(parseErrorBody(JSON.stringify({ error: { message: 'plain' } })).message).toBe('plain')
  })
})

// ---------------------------------------------------------------------------
// Audit edge cases
// ---------------------------------------------------------------------------

describe('think-tag edge cases', () => {
  it('an empty think block (thinking disabled) yields no reasoning block', async () => {
    expect(await chatBlocks({ content: '<think>' }, { content: '\n\n' }, { content: '</think>' }, { content: '\n\nHello' }))
      .toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('keeps the answer\'s own leading indentation after the think block', async () => {
    const blocks = await chatBlocks({ content: '<think>p</think>\n    indented code' })
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '    indented code' })
  })

  it('never reads a refusal for think tags', async () => {
    expect(await chatBlocks({ refusal: '<think>x</think>no' })).toEqual([{ type: 'text', text: '<think>x</think>no' }])
  })

  it('can be turned off per endpoint', async () => {
    const blocks = endedBlocks(await collect(translateChatCompletionsStream(
      sse(deltas({ content: '<think>hi</think> is a tag' })), 'test', { thinkTags: false },
    )))
    expect(blocks).toEqual([{ type: 'text', text: '<think>hi</think> is a tag' }])
  })

  it('drops held-back whitespace instead of opening a blank text block after a tool call', async () => {
    const chunks = await collect(translateChatCompletionsStream(sse([
      { choices: [{ index: 0, delta: { content: '\n' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]), 'test'))
    expect(endedBlocks(chunks).map(b => b.type)).toEqual(['tool-call'])
  })

  it('releases held-back content ahead of a refusal, then stops reading tags', async () => {
    expect(await chatBlocks({ content: '<thi' }, { refusal: 'no' }, { content: '<think>x</think>' }))
      .toEqual([{ type: 'text', text: '<thino<think>x</think>' }])
  })

  it('drops a close tag cut off by the token limit instead of keeping it as reasoning', async () => {
    const blocks = endedBlocks(await collect(translateChatCompletionsStream(sse([
      { choices: [{ index: 0, delta: { content: '<think>abc</thi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ]), 'test')))
    expect(blocks).toMatchObject([{ type: 'reasoning', text: 'abc' }])
  })

  it('never recovers a JSON answer from <think> scratch work', async () => {
    const blocks = endedBlocks(await collect(translateChatCompletionsStream(
      sse(deltas({ content: '<think>{"plan":1}</think>' })), 'test', { jsonOutput: true },
    )))
    expect(blocks.map(block => block.type)).toEqual(['reasoning'])
  })
})

describe('Responses raw reasoning edge cases', () => {
  it('ignores malformed persisted content parts and needs an item id to replay raw content', () => {
    const replayed = (providerState: unknown) => serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({ source: SOURCE, content: [
        { type: 'reasoning', text: 't', kind: 'content', providerState },
        { type: 'text', text: 'answer' },
      ] })],
    }), RESPONSES_DIALECT).input[0]
    expect(replayed({ id: 'rs_1', content: ['', { text: 'x' }, 'kept'] }))
      .toEqual({ type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'kept' }] })
    expect(replayed({ content: ['no id'] })).toMatchObject({ type: 'message' })
    // Raw thoughts without an item id are dropped, never resent as a summary.
    expect(replayed({ content: ['raw'], encryptedContent: 'opaque' }))
      .toEqual({ type: 'reasoning', summary: [], encrypted_content: 'opaque' })
    // Deltas-only raw text whose done item kept just the id and encrypted_content.
    expect(replayed({ id: 'rs_2', encryptedContent: 'ENC' }))
      .toEqual({ type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'ENC' })
    expect(replayed({ encryptedContent: 'ENC' }))
      .toEqual({ type: 'reasoning', summary: [], encrypted_content: 'ENC' })
  })

  it('never resends streamed raw reasoning as a summary when the done item drops content', async () => {
    const blocks = await responsesBlocks([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: 'raw thought' },
      { type: 'response.output_item.done',
        item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC' } },
      { type: 'response.completed', response: {} },
    ])
    expect(blocks[0]).toMatchObject({ type: 'reasoning', text: 'raw thought', kind: 'content' })
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({ source: SOURCE, content: [...blocks, { type: 'text', text: 'answer' }] })],
    }), RESPONSES_DIALECT)
    expect(body.input[0]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' })
  })

  it('separates streamed raw-reasoning parts the way the done item joins them', async () => {
    const chunks = []
    for await (const chunk of translateResponsesStream(sse([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', content_index: 0, delta: 'one' },
      { type: 'response.reasoning_text.delta', item_id: 'rs_1', content_index: 1, delta: 'two' },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', content: [
        { type: 'reasoning_text', text: 'one' }, { type: 'reasoning_text', text: 'two' },
      ] } },
      { type: 'response.completed', response: {} },
    ]), 'test')) chunks.push(chunk)
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toMatchObject({ block: { text: 'one\n\ntwo', providerState: { content: ['one', 'two'] } } })
  })
})

// ---------------------------------------------------------------------------
// Anthropic Messages wire served by an OpenAI-compatible gateway
// ---------------------------------------------------------------------------

describe('Messages API: JSON answer left in a thinking block', () => {
  function messagesStream(thinking: string, stop = 'end_turn'): object[] {
    return [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'erased' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]
  }

  async function messagesBlocks(values: object[], jsonOutput: boolean): Promise<ContentBlock[]> {
    const chunks = []
    for await (const chunk of translateAnthropicStream(sse(values), 'test', { jsonOutput })) chunks.push(chunk)
    return chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
  }

  it('emits the thinking as the answer when JSON was requested and no text came', async () => {
    const blocks = await messagesBlocks(messagesStream('{"capital":"Hanoi"}'), true)
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '{"capital":"Hanoi"}' })
  })

  it('leaves non-JSON thinking, truncated turns and plain requests alone', async () => {
    expect((await messagesBlocks(messagesStream('not json'), true)).map(b => b.type)).toEqual(['reasoning'])
    expect((await messagesBlocks(messagesStream('{"a":1}', 'max_tokens'), true)).map(b => b.type)).toEqual(['reasoning'])
    expect((await messagesBlocks(messagesStream('{"a":1}'), false)).map(b => b.type)).toEqual(['reasoning'])
  })
})

describe('audit follow-ups', () => {
  it('classifies errors inlined into a 200 stream by their wording, like an HTTP failure', async () => {
    const thrown = async (error: object) => {
      try { await collect(translateChatCompletionsStream(sse([{ error }]), 'test')) }
      catch (caught: unknown) { return caught as ModelError }
      throw new Error('stream did not fail')
    }
    expect(await thrown({ code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens' }))
      .toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE,
        message: 'maximum context length is 8192 tokens (context_length_exceeded)' })
    expect(await thrown({ code: 'insufficient_quota', message: 'no balance' })).toMatchObject({ code: QUOTA_EXCEEDED_CODE })
    // Terminal like a filtered HTTP 400 and a `content_filter` finish.
    expect(await thrown({ message: 'blocked by content_filter' }))
      .toMatchObject({ code: MODEL_ERROR_CODES.INVALID_REQUEST })
    expect(await thrown('upstream timeout' as unknown as object))
      .toMatchObject({ code: MODEL_ERROR_CODES.SERVER, message: 'upstream timeout' })
    // Anything else stays retryable: the turn produced nothing usable.
    expect(await thrown({ code: 502, message: 'Provider returned error' }))
      .toMatchObject({ code: MODEL_ERROR_CODES.SERVER, message: 'Provider returned error (502)' })
    expect(await thrown({})).toMatchObject({ code: MODEL_ERROR_CODES.SERVER, message: 'test reported an error mid-stream' })
    expect(await thrown({ code: '', type: 'server_error', message: '' }))
      .toMatchObject({ code: MODEL_ERROR_CODES.SERVER, message: 'test reported an error mid-stream (server_error)' })
  })

  it('maps a moderation 400 and a plain-string error body the same way on every provider', () => {
    // INVALID_REQUEST, as for a `content_filter` finish: no retry, no failover,
    // and the member that refused is not put in cooldown.
    const filtered = parseErrorBody(JSON.stringify({ error: { code: 'content_filter', message: 'prompt was filtered' } }))
    expect(httpErrorCode(400, filtered.detail)).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)
    expect(httpErrorCode(422, filtered.detail)).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)
    expect(httpErrorCode(500, filtered.detail)).toBe(MODEL_ERROR_CODES.SERVER)
    expect(parseErrorBody(JSON.stringify({ error: 'Rate limit reached' })))
      .toEqual({ message: 'Rate limit reached', detail: '' })
    expect(isContentFilteredError('content_policy_violation')).toBe(true)
    expect(isContentFilteredError('invalid schema')).toBe(false)
  })

  it('keeps a gateway `description` on errors inlined into a 200 stream', async () => {
    const error = { message: 'Bad request', description: 'Invalid image URL' }
    await expect(collect(translateChatCompletionsStream(sse([{ error }]), 'test')))
      .rejects.toThrow('Bad request: Invalid image URL')
    expect(chatCompletionsStreamError(error, 'test').message).toBe('Bad request: Invalid image URL')
  })

  async function adapterBlocks(baseUrl: string | undefined, thinkTags?: boolean): Promise<string[]> {
    const fetch = vi.fn(async () => new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"<think>x</think>answer"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ].join('\n\n') + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const adapter = openAiAdapter({
      apiKey: 'key', api: 'chat-completions', fetch,
      ...baseUrl === undefined ? {} : { baseUrl },
      ...thinkTags === undefined ? {} : { compat: { thinkTags } },
    })
    const types: string[] = []
    for await (const chunk of adapter.stream({ provider: 'openai', model: 'm', messages: [] })) {
      if (chunk.type === 'block-end') types.push(chunk.block.type)
    }
    return types
  }

  it('reads <think> tags from compatible endpoints but not from OpenAI itself', async () => {
    expect(await adapterBlocks(undefined)).toEqual(['text'])
    expect(await adapterBlocks('https://api.openai.com/v1')).toEqual(['text'])
    expect(await adapterBlocks('https://API.OpenAI.com./v1')).toEqual(['text'])
    expect(await adapterBlocks('https://local.invalid/v1')).toEqual(['reasoning', 'text'])
    expect(await adapterBlocks('https://local.invalid/v1', false)).toEqual(['text'])
    expect(await adapterBlocks(undefined, true)).toEqual(['reasoning', 'text'])
  })
})

describe('Chat Completions reasoning replay across failover members', () => {
  const sseBody = (frames: readonly object[]) => new Response(
    `${frames.map(frame => `data: ${JSON.stringify(frame)}`).join('\n\n')}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  const toolRound = () => sseBody([
    { choices: [{ index: 0, delta: { reasoning_content: 'need lookup' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const answer = () => sseBody([{ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }])
  const sent = (fetch: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(String((fetch.mock.calls[call] as [unknown, RequestInit])[1].body)) as { messages: Record<string, unknown>[] }

  async function secondRound(memberAFails: boolean) {
    let callsA = 0
    const fetchA = vi.fn(async () => {
      callsA += 1
      if (callsA === 1) return toolRound()
      return memberAFails ? new Response('{"error":{"message":"overloaded"}}', { status: 503 }) : answer()
    })
    const fetchB = vi.fn(async () => answer())
    const member = (id: string, fetch: typeof fetchA) => ({
      id, provider: 'llm', adapter: openAiAdapter({ apiKey: 'k', api: 'chat-completions', baseUrl: `https://${id}.invalid/v1`, fetch }),
    })
    const failover = withFailover([member('a', fetchA), member('b', fetchB)])
    const first: ProtocolStreamChunk[] = []
    const question = createTextMessage('q')
    for await (const chunk of failover.stream({ provider: 'llm', model: 'same-model', messages: [question] })) first.push(chunk as ProtocolStreamChunk)
    const finish = first.find(chunk => chunk.type === 'finish')
    const history: Message[] = [question,
      createAssistantMessage({ source: { provider: 'llm', model: 'same-model',
        replayState: finish?.type === 'finish' ? finish.replayState : undefined }, content: endedBlocks(first) }),
      createToolResultMessage({ callId: ToolCallId('call_1'), content: [{ type: 'text', text: 'r' }], isError: false })]
    for await (const _chunk of failover.stream({ provider: 'llm', model: 'same-model', messages: history })) { /* drain */ }
    return { fetchA, fetchB }
  }

  it('replays reasoning to the member that produced it', async () => {
    const { fetchA, fetchB } = await secondRound(false)
    expect(fetchB).not.toHaveBeenCalled()
    expect(sent(fetchA, 1).messages.find(m => m.role === 'assistant')).toMatchObject({ reasoning_content: 'need lookup' })
  })

  it('does not send it to another member serving the same model id', async () => {
    const { fetchA, fetchB } = await secondRound(true)
    expect(sent(fetchA, 1).messages.find(m => m.role === 'assistant')).toMatchObject({ reasoning_content: 'need lookup' })
    expect(fetchB).toHaveBeenCalledTimes(1)
    expect(sent(fetchB, 0).messages.find(m => m.role === 'assistant')).not.toHaveProperty('reasoning_content')
  })
})
