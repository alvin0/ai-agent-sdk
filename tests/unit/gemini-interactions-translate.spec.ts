import { describe, expect, it } from 'vitest'
import { validateUsageCounters } from '@alvin0/ai-agent-sdk-core'
import {
  translateGeminiInteractionsStream,
  type ProtocolSseEvent,
} from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'

async function* events(values: readonly object[]): AsyncIterable<ProtocolSseEvent> {
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}

async function translate(values: readonly object[]) {
  const chunks = []
  for await (const chunk of translateGeminiInteractionsStream(events(values), 'Gemini test')) {
    chunks.push(chunk)
  }
  return chunks
}

describe('Gemini Interactions SSE translation', () => {
  it('streams text, preserves thought signature, and reports disjoint usage', async () => {
    const chunks = await translate([
      { event_type: 'interaction.created', interaction: { status: 'in_progress' } },
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig_1' } },
      { event_type: 'step.delta', index: 0, delta: {
        type: 'thought_summary', content: { type: 'text', text: 'Checking.' },
      } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Hello' } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text: ' world' } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed', interaction: {
        status: 'completed',
        usage: {
          total_input_tokens: 10, total_cached_tokens: 4,
          total_output_tokens: 2, total_thought_tokens: 3, total_tokens: 15,
        },
      } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: {
        type: 'reasoning', text: 'Checking.',
        providerState: {
          signature: 'sig_1', summary: [{ type: 'text', text: 'Checking.' }],
        },
      },
    })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' },
    })
    const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
    expect(usage).toEqual({
      inputTokens: 6, cacheReadTokens: 4, outputTokens: 5,
      reasoningTokens: 3, totalTokens: 15,
    })
    expect(validateUsageCounters(usage, true).complete).toBe(true)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('accumulates streamed function arguments and terminates for tool calls', async () => {
    const chunks = await translate([
      { event_type: 'step.start', index: 7, step: {
        type: 'function_call', id: 'call_7', name: 'weather', arguments: {},
      } },
      { event_type: 'step.delta', index: 7, delta: { type: 'arguments_delta', arguments: '{"city":' } },
      { event_type: 'step.delta', index: 7, delta: { type: 'arguments_delta', arguments: '"Hanoi"}' } },
      { event_type: 'step.stop', index: 7 },
      { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call_7', name: 'weather', arguments: '{"city":"Hanoi"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('uses initial model-output content and URL annotations', async () => {
    const chunks = await translate([
      { event_type: 'step.start', index: 0, step: {
        type: 'model_output',
        content: [{
          type: 'text', text: 'Source', annotations: [{
            type: 'url_citation', url: 'https://example.com', title: 'Example',
            start_index: 0, end_index: 6,
          }],
        }],
      } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { status: 'completed' } },
    ])
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: {
        type: 'text', text: 'Source', annotations: [{
          type: 'url-citation', url: 'https://example.com', title: 'Example',
          startIndex: 0, endIndex: 6,
          providerState: {
            type: 'url_citation', url: 'https://example.com', title: 'Example',
            start_index: 0, end_index: 6,
          },
        }],
      },
    })
  })

  it('fails closed for malformed and truncated streams', async () => {
    async function* malformed(): AsyncIterable<ProtocolSseEvent> {
      yield { event: 'step.delta', data: '{bad' }
    }
    await expect(async () => {
      for await (const _chunk of translateGeminiInteractionsStream(malformed(), 'Gemini test')) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    await expect(async () => {
      for await (const _chunk of translateGeminiInteractionsStream(events([
        { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      ]), 'Gemini test')) { /* drain */ }
    }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
