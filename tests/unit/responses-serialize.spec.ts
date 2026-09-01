import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import {
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
} from '@ai-agent-sdk/core'
import {
  serializeResponsesRequest,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
import { providerRequest } from './fixtures.ts'

const dialect: ResponsesDialect = {
  sampling: true,
  maxOutputTokens: true,
  store: false,
  include: ['reasoning.encrypted_content'],
}

describe('serializeResponsesRequest', () => {
  it('hoists the system prompt into instructions rather than a message item', () => {
    const body = serializeResponsesRequest(providerRequest({
      system: 'be terse',
      messages: [createTextMessage('hi')],
    }), dialect)
    expect(body.instructions).toBe('be terse')
    expect(body.input).toHaveLength(1)
  })

  it('sends an assistant turn as output_text, not input_text', () => {
    // Sending the model's own prior words as `input_text` would present them as
    // if the user had said them.
    const body = serializeResponsesRequest(providerRequest({
      messages: [
        createTextMessage('hi'),
        createAssistantMessage({
          content: [{ type: 'text', text: 'hello' }],
          source: { provider: 'p', model: 'm' },
        }),
      ],
    }), dialect)
    const assistant = body.input[1]
    expect(assistant?.type).toBe('message')
    if (assistant?.type !== 'message') return
    expect(assistant.content[0]).toEqual({ type: 'output_text', text: 'hello' })
  })

  it('replays Codex commentary phase only when the endpoint dialect accepts it', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'checking now', phase: 'commentary' }],
      source: { provider: 'codex', model: 'm' },
    })
    const codex = serializeResponsesRequest(providerRequest({ messages: [message] }), {
      ...dialect, messagePhase: true,
    })
    expect(codex.input[0]).toMatchObject({ type: 'message', phase: 'commentary' })

    const openai = serializeResponsesRequest(providerRequest({ messages: [message] }), dialect)
    expect(openai.input[0]).not.toHaveProperty('phase')
  })

  it('lifts a tool result to a top-level item instead of nesting it in a message', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createToolResultMessage({
        callId: ToolCallId('call_1'),
        content: [{ type: 'text', text: '22C' }],
        isError: false,
      })],
    }), dialect)
    expect(body.input).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '22C' },
    ])
  })

  it('expands one assistant turn into ordered reasoning, text, and call items', () => {
    // The relative order is what the model reads back as its own prior turn, so
    // flattening must not reshuffle it.
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'let me check', providerState: { id: 'rs_1', summary: ['let me check'] } },
          { type: 'text', text: 'checking now' },
          { type: 'tool-call', id: ToolCallId('call_a'), name: 'lookup', arguments: '{"q":"a"}' },
          { type: 'tool-call', id: ToolCallId('call_b'), name: 'lookup', arguments: '{"q":"b"}' },
        ],
        source: { provider: 'p', model: 'm' },
      })],
    }), dialect)
    expect(body.input.map(item => item.type)).toEqual([
      'reasoning',
      'message',
      'function_call',
      'function_call',
    ])
  })

  it('round-trips reasoning state so the model keeps its chain of thought', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{
          type: 'reasoning',
          text: 'summary text',
          providerState: { id: 'rs_9', encryptedContent: 'opaque', summary: ['summary text'] },
        }],
        source: { provider: 'p', model: 'm' },
      })],
    }), dialect)
    expect(body.input[0]).toEqual({
      type: 'reasoning',
      id: 'rs_9',
      summary: [{ type: 'summary_text', text: 'summary text' }],
      encrypted_content: 'opaque',
    })
  })

  it('encodes a base64 image as a data URL', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createTextMessage('look')],
    }), dialect)
    expect(body.input).toHaveLength(1)

    const withImage = serializeResponsesRequest(providerRequest({
      messages: [{
        ...createTextMessage('look'),
        content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } }],
      }],
    }), dialect)
    const item = withImage.input[0]
    if (item?.type !== 'message') throw new Error('expected a message item')
    expect(item.content[0]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAA',
    })
  })

  it('supports file-backed images and the original detail level', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [{
        ...createTextMessage('inspect'),
        content: [{
          type: 'image',
          source: { kind: 'file', fileId: 'file_image_1' },
          detail: 'original',
        }],
      }],
    }), dialect)
    const item = body.input[0]
    if (item?.type !== 'message') throw new Error('expected a message item')
    expect(item.content[0]).toEqual({
      type: 'input_image', file_id: 'file_image_1', detail: 'original',
    })
  })

  it('maps reasoning effort and provider-native tools', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createTextMessage('find and illustrate the latest result')],
      reasoningEffort: ReasoningEffortId('medium'),
      tools: [
        {
          type: 'native', name: 'web-search', searchContextSize: 'high',
          allowedDomains: ['example.com'],
          userLocation: { country: 'VN', timezone: 'Asia/Bangkok' },
        },
        {
          type: 'native', name: 'image-generation', format: 'webp',
          quality: 'high', partialImages: 2,
        },
      ],
    }), dialect)
    expect(body.reasoning).toMatchObject({ effort: 'medium' })
    expect(body.tools).toEqual([
      {
        type: 'web_search', search_context_size: 'high',
        filters: { allowed_domains: ['example.com'] },
        user_location: { type: 'approximate', country: 'VN', timezone: 'Asia/Bangkok' },
      },
      {
        type: 'image_generation', output_format: 'webp', quality: 'high', partial_images: 2,
      },
    ])
  })

  it('replays native tool state in later stateless requests', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{
          type: 'native-tool-call', id: 'ws_1', name: 'web-search', content: [],
          providerState: {
            type: 'web_search_call', id: 'ws_1', status: 'completed',
            action: { type: 'search', query: 'SDK' },
          },
        }],
        source: { provider: 'openai', model: 'm' },
      })],
    }), dialect)
    expect(body.input).toEqual([{
      type: 'web_search_call', id: 'ws_1', status: 'completed',
      action: { type: 'search', query: 'SDK' },
    }])
  })

  it('replaces empty tool arguments with valid JSON', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('c'), name: 'noop', arguments: '' }],
        source: { provider: 'p', model: 'm' },
      })],
    }), dialect)
    const item = body.input[0]
    if (item?.type !== 'function_call') throw new Error('expected a function_call item')
    expect(item.arguments).toBe('{}')
  })

  it('omits sampling and output cap for a dialect that has no such fields', () => {
    const codexLike: ResponsesDialect = { ...dialect, sampling: false, maxOutputTokens: false }
    const body = serializeResponsesRequest(providerRequest({
      messages: [createTextMessage('hi')],
      temperature: 0.5,
      topP: 0.9,
    }), codexLike)
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.max_output_tokens).toBeUndefined()
  })

  it('sends sampling and output cap for a dialect that accepts them', () => {
    const body = serializeResponsesRequest(providerRequest({
      messages: [createTextMessage('hi')],
      temperature: 0.5,
    }, 1_234), dialect)
    expect(body.temperature).toBe(0.5)
    expect(body.max_output_tokens).toBe(1_234)
  })

  it('maps the neutral tool-choice vocabulary', () => {
    const named = serializeResponsesRequest(providerRequest({
      messages: [createTextMessage('hi')],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 't' },
    }), dialect)
    expect(named.tool_choice).toEqual({ type: 'function', name: 't' })
    expect(named.tools?.[0]).toEqual({
      type: 'function',
      name: 't',
      description: 'd',
      strict: false,
      parameters: { type: 'object' },
    })
  })
})
