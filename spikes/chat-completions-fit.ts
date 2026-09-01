/**
 * SPIKE D — can Chat Completions fit the existing WireProtocol seam?
 *
 * This is deliberately a representative slice, not production protocol code.
 * It covers the load-bearing tool-loop shapes: assistant tool calls, tool
 * results, parallel streamed argument deltas, usage, and `[DONE]` termination.
 *
 * Run: `node spikes/chat-completions-fit.ts`
 */

import assert from 'node:assert/strict'
import { isNativeToolSchema, type ToolChoice, type ToolSchema } from '@ai-agent-sdk/core'
import type { ContentBlock } from '@ai-agent-sdk/core'
import {
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
  type Message,
} from '@ai-agent-sdk/core'
import { ToolCallId } from '@ai-agent-sdk/core'
import { BlockAssembler } from '@ai-agent-sdk/core'
import type { StreamChunk, TokenUsage } from '@ai-agent-sdk/core'
import type { SseEvent } from '../src/core/stream/sse.ts'
import type { ProviderRequest } from '../src/providers/base/http-adapter.ts'
import type { WireProtocol } from '../src/providers/protocols/protocol.ts'

interface ChatDialect {
  readonly reasoningEffort: boolean
}

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  tool_choice?: ChatToolChoice
  stream: true
  stream_options: { include_usage: true }
  reasoning_effort?: string
}

type ChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function messageOf(message: Message): ChatMessage | undefined {
  if (message.source.kind === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.source.callId,
      content: textOf(message.content.flatMap(block =>
        block.type === 'tool-result' ? block.content : [block])),
    }
  }
  if (message.role === 'system' || message.role === 'user') {
    return { role: message.role, content: textOf(message.content) }
  }

  const calls = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
      block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments || '{}' },
    }))
  const content = textOf(message.content)
  return {
    role: 'assistant',
    content: content.length === 0 ? null : content,
    ...calls.length === 0 ? {} : { tool_calls: calls },
  }
}

function toolChoiceOf(choice: ToolChoice): ChatToolChoice {
  return typeof choice === 'string'
    ? choice
    : { type: 'function', function: { name: choice.name } }
}

function serialize(request: ProviderRequest, dialect: ChatDialect): ChatRequest {
  const messages = request.options.messages
    .map(messageOf)
    .filter((message): message is ChatMessage => message !== undefined)
  if (request.options.system !== undefined) {
    messages.unshift({ role: 'system', content: request.options.system })
  }
  const tools = request.options.tools
    ?.filter((tool): tool is ToolSchema => !isNativeToolSchema(tool))
    .map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  return {
    model: request.options.model,
    messages,
    ...tools === undefined || tools.length === 0 ? {} : { tools },
    ...request.options.toolChoice === undefined
      ? {}
      : { tool_choice: toolChoiceOf(request.options.toolChoice) },
    stream: true,
    stream_options: { include_usage: true },
    ...dialect.reasoningEffort && request.options.reasoningEffort !== undefined
      ? { reasoning_effort: String(request.options.reasoningEffort) }
      : {},
  }
}

interface OpenBlock {
  index: number
  kind: 'text' | 'tool-call'
  text: string
  id?: string
  name?: string
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

function usageOf(chunk: NonNullable<ChatChunk['usage']>): TokenUsage {
  const prompt = chunk.prompt_tokens ?? 0
  const cached = chunk.prompt_tokens_details?.cached_tokens ?? 0
  const output = chunk.completion_tokens ?? 0
  return {
    inputTokens: Math.max(prompt - cached, 0),
    outputTokens: output,
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...chunk.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: chunk.completion_tokens_details.reasoning_tokens },
    ...chunk.total_tokens === undefined ? {} : { totalTokens: chunk.total_tokens },
  }
}

async function* translate(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let text: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let finish: 'stop' | 'tool-calls' | 'max-tokens' = 'stop'
  let usage: TokenUsage | undefined

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const event of events) {
    if (event.data === '[DONE]') {
      for (const block of order) {
        yield block.kind === 'text'
          ? { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
          : {
            type: 'block-end',
            index: block.index,
            block: {
              type: 'tool-call',
              id: ToolCallId(block.id ?? `call-${block.index}`),
              name: block.name ?? '',
              arguments: block.text,
            },
          }
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: finish } }
      return
    }

    const chunk = JSON.parse(event.data) as ChatChunk
    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (text === undefined) {
          text = open('text')
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.text += content
        yield { type: 'text-delta', index: text.index, text: content }
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.id = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.id ?? `call-${block.index}`),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: fragment,
        }
      }
      if (choice.finish_reason === 'tool_calls') finish = 'tool-calls'
      else if (choice.finish_reason === 'length') finish = 'max-tokens'
    }
    if (chunk.usage !== undefined && chunk.usage !== null) usage = usageOf(chunk.usage)
  }
  throw new Error('Chat Completions stream ended without [DONE]')
}

const protocol: WireProtocol<ChatDialect> = {
  id: 'openai-chat-completions-spike',
  defaultDialect: { reasoningEffort: true },
  endpointPath: () => '/chat/completions',
  serialize,
  translate: (events) => translate(events),
}

const first = ToolCallId('call_a')
const second = ToolCallId('call_b')
const messages = [
  createTextMessage('inspect both'),
  createAssistantMessage({
    source: { provider: 'spike', model: 'spike' },
    content: [
      { type: 'text', text: 'I will inspect both.' },
      { type: 'tool-call', id: first, name: 'read_file', arguments: '{"p":"a"}' },
      { type: 'tool-call', id: second, name: 'read_file', arguments: '{"p":"b"}' },
    ],
  }),
  createToolResultMessage({
    callId: first,
    content: [{ type: 'text', text: 'A' }],
    isError: false,
  }),
  createToolResultMessage({
    callId: second,
    content: [{ type: 'text', text: 'B' }],
    isError: false,
  }),
]

const request = {
  options: {
    provider: 'spike',
    model: 'spike-model',
    system: 'Be precise.',
    messages,
    tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
    toolChoice: 'auto' as const,
  },
  maxTokens: 1024,
} as unknown as ProviderRequest

const body = await protocol.serialize(request, protocol.defaultDialect) as ChatRequest
assert.equal(protocol.endpointPath(request, protocol.defaultDialect), '/chat/completions')
assert.deepEqual(body.messages.map(message => message.role), [
  'system', 'user', 'assistant', 'tool', 'tool',
])
assert.equal((body.messages[2] as Extract<ChatMessage, { role: 'assistant' }>).tool_calls?.length, 2)

async function* events(): AsyncGenerator<SseEvent> {
  yield { event: undefined, data: JSON.stringify({ choices: [{ delta: { content: 'Done. ' } }] }) }
  yield {
    event: undefined,
    data: JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_x', function: { name: 'read_file', arguments: '{"p":' } },
      { index: 1, id: 'call_y', function: { name: 'read_file', arguments: '{"p":' } },
    ] } }] }),
  }
  yield {
    event: undefined,
    data: JSON.stringify({ choices: [{
      delta: { tool_calls: [
        { index: 0, function: { arguments: '"x"}' } },
        { index: 1, function: { arguments: '"y"}' } },
      ] },
      finish_reason: 'tool_calls',
    }], usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
    } }),
  }
  yield { event: undefined, data: '[DONE]' }
}

const assembler = new BlockAssembler()
for await (const chunk of protocol.translate(events(), request, 'spike')) assembler.push(chunk)
assert.deepEqual(assembler.blocks(), [
  { type: 'text', text: 'Done. ' },
  { type: 'tool-call', id: 'call_x', name: 'read_file', arguments: '{"p":"x"}' },
  { type: 'tool-call', id: 'call_y', name: 'read_file', arguments: '{"p":"y"}' },
])
assert.deepEqual(assembler.finish, { kind: 'tool-calls' })
assert.deepEqual(assembler.usage, {
  inputTokens: 60,
  outputTokens: 20,
  cacheReadTokens: 40,
  totalTokens: 120,
})

console.log('\nSPIKE D — Chat Completions protocol fit\n')
console.log('  WireProtocol integration      : PASS (no base/core/loop change)')
console.log('  assistant calls + tool result : PASS')
console.log('  parallel streamed tool calls  : PASS')
console.log('  usage + termination           : PASS')
console.log('  Responses reasoning replay    : UNAVAILABLE (documented capability loss)')
console.log('  production scope              : protocol + tests, not a loop blocker\n')
