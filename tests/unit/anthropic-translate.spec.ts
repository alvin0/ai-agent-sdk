import { describe, expect, it } from 'vitest'
import type { SseEvent } from '../../src/core/stream/sse.ts'
import { translateAnthropicStream } from '../../src/providers/anthropic/translate.ts'

async function* events(values: readonly object[]): AsyncIterable<SseEvent> {
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
