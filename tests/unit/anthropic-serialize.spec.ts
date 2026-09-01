import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@ai-agent-sdk/core'
import {
  createAssistantMessage,
  createTextMessage,
  createToolResultMessage,
} from '@ai-agent-sdk/core'
import {
  DEFAULT_THINKING_BUDGETS,
  serializeAnthropicRequest,
} from '@ai-agent-sdk/protocol-anthropic-messages'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { providerRequest } from './fixtures.ts'

const options = { budgets: DEFAULT_THINKING_BUDGETS }

describe('serializeAnthropicRequest', () => {
  it('merges consecutive tool results into one user message', () => {
    // This is the parallel-tool-use case. Three separate result messages must
    // arrive as three tool_result blocks in ONE user message, or the provider
    // rejects the turn.
    const body = serializeAnthropicRequest(providerRequest({
      messages: [
        createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [{ type: 'text', text: 'one' }],
          isError: false,
        }),
        createToolResultMessage({
          callId: ToolCallId('c2'),
          content: [{ type: 'text', text: 'two' }],
          isError: false,
        }),
        createToolResultMessage({
          callId: ToolCallId('c3'),
          content: [{ type: 'text', text: 'three' }],
          isError: false,
        }),
      ],
    }), options)

    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.role).toBe('user')
    expect(body.messages[0]?.content).toHaveLength(3)
    expect(body.messages[0]?.content.map(b => b.type)).toEqual([
      'tool_result',
      'tool_result',
      'tool_result',
    ])
  })

  it('does not merge across a role change', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [
        createTextMessage('a'),
        createAssistantMessage({
          content: [{ type: 'text', text: 'b' }],
          source: { provider: 'p', model: 'm' },
        }),
        createTextMessage('c'),
      ],
    }), options)
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('parses tool arguments into an object, since this API wants input not a string', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('c1'),
          name: 'search',
          arguments: '{"q":"hello"}',
        }],
        source: { provider: 'p', model: 'm' },
      })],
    }), options)
    expect(body.messages[0]?.content[0]).toEqual({
      type: 'tool_use',
      id: 'c1',
      name: 'search',
      input: { q: 'hello' },
    })
  })

  it('degrades invalid tool JSON to an empty object rather than failing the request', () => {
    // The model emitted broken JSON. Keeping the conversation well-formed lets
    // the tool layer report it back; failing here would be unrecoverable.
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: ToolCallId('c1'),
          name: 'search',
          arguments: '{"q":"unterminated',
        }],
        source: { provider: 'p', model: 'm' },
      })],
    }), options)
    const block = body.messages[0]?.content[0]
    if (block?.type !== 'tool_use') throw new Error('expected a tool_use block')
    expect(block.input).toEqual({})
  })

  it('drops a thinking block that has no signature', () => {
    // Unsigned thinking is rejected outright by this API, so it cannot be sent.
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'unsigned thought' },
          { type: 'text', text: 'answer' },
        ],
        source: { provider: 'p', model: 'm' },
      })],
    }), options)
    expect(body.messages[0]?.content.map(b => b.type)).toEqual(['text'])
  })

  it('keeps a signed thinking block so the model can verify its own reasoning', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [{
          type: 'reasoning',
          text: 'signed thought',
          providerState: { kind: 'thinking', signature: 'sig-abc' },
        }],
        source: { provider: 'p', model: 'm' },
      })],
    }), options)
    expect(body.messages[0]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'signed thought',
      signature: 'sig-abc',
    })
  })

  it('always sends max_tokens, which this API requires', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
    }, 1_500), options)
    expect(body.max_tokens).toBe(1_500)
  })

  it('spells "call some tool" as any, not required', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
      toolChoice: 'required',
    }), options)
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  it('maps provider-native web search without treating it as a host function', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('search')],
      tools: [{
        type: 'native', name: 'web-search', maxUses: 3,
        allowedDomains: ['example.com'], userLocation: { country: 'VN' },
      }],
      toolChoice: { type: 'native', name: 'web-search' },
    }), options)
    expect(body.tools).toEqual([{
      type: 'web_search_20250305', name: 'web_search', max_uses: 3,
      allowed_domains: ['example.com'],
      user_location: { type: 'approximate', country: 'VN' },
    }])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'web_search' })
  })

  it('rejects unsupported native image generation explicitly', () => {
    expect(() => serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('draw')],
      tools: [{ type: 'native', name: 'image-generation' }],
    }), options)).toThrow(/does not support.*image-generation/i)
  })

  it('replays an Anthropic server search and its encrypted result unchanged', () => {
    const state = {
      call: {
        type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search',
        input: { query: 'SDK' },
      },
      result: {
        type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
        content: [{
          type: 'web_search_result', url: 'https://example.com', title: 'SDK',
          encrypted_content: 'opaque', page_age: null,
        }],
      },
    }
    const citation = {
      type: 'web_search_result_location', url: 'https://example.com', title: 'SDK',
      encrypted_index: 'index', cited_text: 'citation',
    }
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createAssistantMessage({
        content: [
          {
            type: 'native-tool-call', id: 'srvtoolu_1', name: 'web-search',
            arguments: { query: 'SDK' }, content: [], providerState: state,
          },
          {
            type: 'text', text: 'Found it.', annotations: [{
              type: 'url-citation', url: 'https://example.com', title: 'SDK',
              providerState: citation,
            }],
          },
        ],
        source: { provider: 'anthropic', model: 'm' },
      })],
    }), options)
    expect(body.messages[0]?.content).toEqual([
      state.call,
      state.result,
      { type: 'text', text: 'Found it.', citations: [citation] },
    ])
  })

  it('rejects file-id image sources instead of corrupting the wire shape', () => {
    expect(() => serializeAnthropicRequest(providerRequest({
      messages: [{
        ...createTextMessage('inspect'),
        content: [{ type: 'image', source: { kind: 'file', fileId: 'file_1' } }],
      }],
    }), options)).toThrow(/URL or base64/i)
  })

  it('drops sampling knobs when extended thinking is enabled', () => {
    // Sending both is rejected by this API.
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.7,
      topP: 0.9,
    }, 40_000), options)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24_576 })
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })

  it('keeps sampling knobs when thinking is off', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
      reasoningEffort: ReasoningEffortId('off'),
      temperature: 0.7,
    }), options)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.temperature).toBe(0.7)
  })

  it('caps the thinking budget below max_tokens so an answer still fits', () => {
    // This API requires budget_tokens < max_tokens and rejects the request
    // otherwise, so a large effort against a small cap must be reduced.
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
      reasoningEffort: ReasoningEffortId('high'),
    }, 4_000), options)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3_000 })
  })

  it('disables thinking when the cap leaves less than the provider minimum', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [createTextMessage('hi')],
      reasoningEffort: ReasoningEffortId('high'),
    }, 1_000), options)
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('drops whitespace-only text, which this API rejects', () => {
    const body = serializeAnthropicRequest(providerRequest({
      messages: [
        { ...createTextMessage('   '), content: [{ type: 'text', text: '   ' }] },
        createTextMessage('real'),
      ],
    }), options)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.content).toEqual([{ type: 'text', text: 'real' }])
  })
})
