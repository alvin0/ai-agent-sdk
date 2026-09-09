import { describe, expect, it } from 'vitest'
import {
  translateAnthropicStream,
  type ProtocolSseEvent,
} from '@ai-agent-sdk/protocol-anthropic-messages'
import { validateUsageCounters } from '@ai-agent-sdk/core'

async function* events(values: readonly object[]): AsyncIterable<ProtocolSseEvent> {
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}

describe('translateAnthropicStream native tools', () => {
  it('pairs a server web-search call with its result and preserves citations', async () => {
    const result = {
      type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
      content: [{
        type: 'web_search_result', url: 'https://example.com', title: 'SDK',
        encrypted_content: 'opaque', page_age: null,
      }],
    }
    const citation = {
      type: 'web_search_result_location', url: 'https://example.com', title: 'SDK',
      encrypted_index: 'index', cited_text: 'citation',
    }
    const chunks = []
    for await (const chunk of translateAnthropicStream(events([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: {
        type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {},
      } },
      { type: 'content_block_delta', index: 0, delta: {
        type: 'input_json_delta', partial_json: '{"query":"SDK"}',
      } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: result },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found it.' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]), 'test')) chunks.push(chunk)

    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: {
        type: 'native-tool-call', id: 'srvtoolu_1', name: 'web-search',
        arguments: { query: 'SDK' }, content: [],
        providerState: {
          call: {
            type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search',
            input: { query: 'SDK' },
          },
          result,
        },
      },
    })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 2,
      block: {
        type: 'text', text: 'Found it.', annotations: [{
          type: 'url-citation', url: 'https://example.com', title: 'SDK',
          providerState: citation,
        }],
      },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('translateAnthropicStream usage normalization', () => {
  const textEvents = (startUsage: object, deltaUsage?: object) => [
    { type: 'message_start', message: { usage: startUsage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta', delta: { stop_reason: 'end_turn' },
      ...(deltaUsage === undefined ? {} : { usage: deltaUsage }),
    },
    { type: 'message_stop' },
  ]

  it('combines split usage and treats omitted cache buckets as authoritative zero', async () => {
    const chunks = []
    for await (const chunk of translateAnthropicStream(events(textEvents(
      { input_tokens: 10 },
      { output_tokens: 5 },
    )), 'test')) chunks.push(chunk)

    const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(validateUsageCounters(usage, true)).toMatchObject({
      complete: true,
      invalidFields: [],
      reported: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
  })

  it('keeps a partial provider report partial instead of inventing zero output', async () => {
    const chunks = []
    for await (const chunk of translateAnthropicStream(events(textEvents(
      { input_tokens: 10 },
    )), 'test')) chunks.push(chunk)

    const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
    expect(usage).toEqual({ inputTokens: 10 })
    expect(validateUsageCounters(usage, true).complete).toBe(false)
  })

  it('retains malformed counters for the accounting boundary to reject', async () => {
    const chunks = []
    for await (const chunk of translateAnthropicStream(events(textEvents(
      { input_tokens: 'not-a-counter' },
      { output_tokens: 5 },
    )), 'test')) chunks.push(chunk)

    const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
    expect(usage).toEqual({ inputTokens: 'not-a-counter', outputTokens: 5 })
    expect(validateUsageCounters(usage, true)).toMatchObject({
      complete: false,
      invalidFields: ['inputTokens'],
      reported: { outputTokens: 5 },
    })
  })
})
