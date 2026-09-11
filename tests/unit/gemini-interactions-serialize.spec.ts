import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
  ReasoningEffortId,
  ToolCallId,
} from '@alvin0/ai-agent-sdk-core'
import {
  serializeGeminiInteractionsRequest,
  type GeminiInteractionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'
import { providerRequest } from './fixtures.ts'

const dialect: GeminiInteractionsDialect = { store: false, thinkingSummaries: 'auto' }

describe('serializeGeminiInteractionsRequest', () => {
  it('targets the Interactions request shape with stateless history', () => {
    const body = serializeGeminiInteractionsRequest(providerRequest({
      system: 'Be concise.',
      messages: [
        createTextMessage('Use the weather tool.'),
        createAssistantMessage({
          content: [
            {
              type: 'reasoning', text: '',
              providerState: { signature: 'opaque-signature' },
            },
            {
              type: 'tool-call', id: ToolCallId('call_1'), name: 'weather',
              arguments: '{"city":"Hanoi"}',
            },
          ],
          source: { provider: 'gemini', model: 'gemini-test' },
        }),
        createToolResultMessage({
          callId: ToolCallId('call_1'),
          content: [{ type: 'text', text: '{"temperature":31}' }],
          isError: false,
        }),
      ],
    }), dialect)

    expect(body).toMatchObject({
      model: 'test-model',
      system_instruction: 'Be concise.',
      stream: true,
      store: false,
      input: [
        { type: 'user_input', content: [{ type: 'text', text: 'Use the weather tool.' }] },
        { type: 'thought', signature: 'opaque-signature' },
        { type: 'function_call', id: 'call_1', name: 'weather', arguments: { city: 'Hanoi' } },
        {
          type: 'function_result', call_id: 'call_1', name: 'weather',
          result: [{ type: 'text', text: '{"temperature":31}' }],
          is_error: false,
        },
      ],
    })
  })

  it('maps JSON Schema output onto response_format', () => {
    const schema = {
      type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'], additionalProperties: false,
    } as const
    const body = serializeGeminiInteractionsRequest(providerRequest({
      messages: [createTextMessage('Answer as JSON.')],
      outputFormat: { type: 'json_schema', name: 'answer', schema },
    }), dialect)
    expect(body.response_format).toEqual({
      type: 'text', mime_type: 'application/json', schema,
    })
  })

  it('maps generation controls, function tools, and exact tool selection', () => {
    const body = serializeGeminiInteractionsRequest(providerRequest({
      messages: [createTextMessage('Check weather.')],
      tools: [{
        name: 'weather', description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
      toolChoice: { type: 'tool', name: 'weather' },
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
      topP: 0.8,
      stop: ['END'],
    }, 321), dialect)
    expect(body.tools).toEqual([{
      type: 'function', name: 'weather', description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    }])
    expect(body.generation_config).toEqual({
      max_output_tokens: 321,
      temperature: 0.2,
      top_p: 0.8,
      stop_sequences: ['END'],
      thinking_level: 'high',
      thinking_summaries: 'auto',
      tool_choice: { allowed_tools: { mode: 'any', tools: ['weather'] } },
    })
  })

  it('maps URL and base64 image input to Gemini content', () => {
    const body = serializeGeminiInteractionsRequest(providerRequest({
      messages: [{
        ...createTextMessage('Inspect images.'),
        content: [
          { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' }, detail: 'high' },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' }, detail: 'low' },
        ],
      }],
    }), dialect)
    expect(body.input).toEqual([{
      type: 'user_input',
      content: [
        { type: 'image', uri: 'https://example.com/a.png', resolution: 'high' },
        { type: 'image', data: 'AAA', mime_type: 'image/png', resolution: 'low' },
      ],
    }])
  })

  it('maps inline, URL, and file-backed PDFs to document content', () => {
    const body = serializeGeminiInteractionsRequest(providerRequest({
      messages: [{
        ...createTextMessage('Summarize these.'),
        content: [
          { type: 'document', source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBER' } },
          { type: 'document', source: { kind: 'url', url: 'https://example.com/a.pdf' } },
          { type: 'document', source: { kind: 'file', fileId: 'files/abc123' } },
        ],
      }],
    }), dialect)
    expect(body.input).toEqual([{
      type: 'user_input',
      content: [
        { type: 'document', data: 'JVBER', mime_type: 'application/pdf' },
        { type: 'document', uri: 'https://example.com/a.pdf', mime_type: 'application/pdf' },
        { type: 'document', uri: 'files/abc123', mime_type: 'application/pdf' },
      ],
    }])
  })

  it('supports bare Google Search but fails closed for unsupported options and image generation', () => {
    const search = serializeGeminiInteractionsRequest(providerRequest({
      messages: [createTextMessage('Search.')],
      tools: [{ type: 'native', name: 'web-search' }],
    }), dialect)
    expect(search.tools).toEqual([{ type: 'google_search', search_types: ['web_search'] }])

    expect(() => serializeGeminiInteractionsRequest(providerRequest({
      messages: [createTextMessage('Search.')],
      tools: [{ type: 'native', name: 'web-search', allowedDomains: ['example.com'] }],
    }), dialect)).toThrow(/does not support SDK search filters or limits/)
    expect(() => serializeGeminiInteractionsRequest(providerRequest({
      messages: [createTextMessage('Draw.')],
      tools: [{ type: 'native', name: 'image-generation' }],
    }), dialect)).toThrow(/does not expose image generation/)
  })
})
