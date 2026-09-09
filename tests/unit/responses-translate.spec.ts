import { describe, expect, it } from 'vitest'
import {
  translateResponsesStream,
  type ProtocolSseEvent,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import { createTextMessage, validateUsageCounters } from '@alvin0/ai-agent-sdk-core'
import { providerRequest } from './fixtures.ts'

async function* events(values: readonly object[]): AsyncIterable<ProtocolSseEvent> {
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}

describe('Responses assistant message phase', () => {
  it('maps commentary phase onto streaming deltas and the authoritative text block', async () => {
    const chunks = []
    for await (const chunk of translateResponsesStream(events([
      { type: 'response.output_item.added', item: { id: 'm1', type: 'message', phase: 'commentary' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Checking now.' },
      { type: 'response.output_item.done', item: {
        id: 'm1', type: 'message', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking now.' }],
      } },
      { type: 'response.completed', response: {} },
    ]), 'test')) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Checking now.', phase: 'commentary' })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'text', text: 'Checking now.', phase: 'commentary' },
    })
  })

  it('keeps native web-search nodes and URL citations', async () => {
    const chunks = []
    for await (const chunk of translateResponsesStream(events([
      { type: 'response.output_item.added', item: { id: 'ws_1', type: 'web_search_call' } },
      { type: 'response.output_item.done', item: {
        id: 'ws_1', type: 'web_search_call', status: 'completed',
        action: { type: 'search', query: 'SDK' },
      } },
      { type: 'response.output_item.added', item: { id: 'm1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Found it.' },
      { type: 'response.output_item.done', item: {
        id: 'm1', type: 'message', content: [{
          type: 'output_text', text: 'Found it.', annotations: [{
            type: 'url_citation', url: 'https://example.com/sdk', title: 'SDK',
            start_index: 0, end_index: 8,
          }],
        }],
      } },
      { type: 'response.completed', response: {} },
    ]), 'test')) chunks.push(chunk)
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: {
        type: 'native-tool-call', id: 'ws_1', name: 'web-search', status: 'completed',
        arguments: { type: 'search', query: 'SDK' }, content: [],
        providerState: {
          id: 'ws_1', type: 'web_search_call', status: 'completed',
          action: { type: 'search', query: 'SDK' },
        },
      },
    })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 1,
      block: {
        type: 'text', text: 'Found it.', annotations: [{
          type: 'url-citation', url: 'https://example.com/sdk', title: 'SDK',
          startIndex: 0, endIndex: 8,
        }],
      },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams partial images and closes with the requested output media type', async () => {
    const chunks = []
    const request = providerRequest({
      messages: [createTextMessage('draw it')],
      tools: [{ type: 'native', name: 'image-generation', format: 'jpeg' }],
    })
    for await (const chunk of translateResponsesStream(events([
      { type: 'response.output_item.added', item: { id: 'ig_1', type: 'image_generation_call' } },
      {
        type: 'response.image_generation_call.partial_image', item_id: 'ig_1',
        partial_image_b64: 'PART', partial_image_index: 0,
      },
      { type: 'response.output_item.done', item: {
        id: 'ig_1', type: 'image_generation_call', status: 'completed', result: 'FINAL',
      } },
      { type: 'response.completed', response: {} },
    ]), 'test', request)) chunks.push(chunk)
    expect(chunks).toContainEqual({
      type: 'image-delta', index: 0, itemId: 'ig_1', data: 'PART',
      mediaType: 'image/jpeg', partialIndex: 0,
    })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: {
        type: 'native-tool-call', id: 'ig_1', name: 'image-generation', status: 'completed',
        content: [{
          type: 'image', source: { kind: 'base64', mediaType: 'image/jpeg', data: 'FINAL' },
        }],
        providerState: {
          id: 'ig_1', type: 'image_generation_call', status: 'completed', result: 'FINAL',
        },
      },
    })
  })
})

describe('Responses usage normalization', () => {
  async function translatedUsage(usage: object) {
    const chunks = []
    for await (const chunk of translateResponsesStream(events([
      { type: 'response.completed', response: { usage } },
    ]), 'test')) chunks.push(chunk)
    return chunks.find(chunk => chunk.type === 'usage')?.usage
  }

  it('treats omitted cache details as authoritative zero', async () => {
    const usage = await translatedUsage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    expect(validateUsageCounters(usage, true)).toMatchObject({
      complete: true,
      invalidFields: [],
      reported: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
  })

  it('subtracts the cached subset while keeping all input buckets disjoint', async () => {
    const usage = await translatedUsage({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 2,
      total_tokens: 12,
    })
    expect(usage).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 4,
    })
    expect(validateUsageCounters(usage, true).complete).toBe(true)
  })

  it('keeps a partial provider report partial instead of inventing zero output', async () => {
    const usage = await translatedUsage({ input_tokens: 10 })
    expect(usage).toEqual({ inputTokens: 10 })
    expect(validateUsageCounters(usage, true).complete).toBe(false)
  })

  it('retains malformed counters for the accounting boundary to reject', async () => {
    const usage = await translatedUsage({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 'not-a-counter' },
      output_tokens: 2,
    })
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 'not-a-counter',
    })
    expect(validateUsageCounters(usage, true)).toMatchObject({
      complete: false,
      invalidFields: ['cacheReadTokens'],
      reported: { inputTokens: 10, outputTokens: 2 },
    })
  })
})
