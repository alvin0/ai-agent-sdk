import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

export const providerId = 'openai'
export const expectedCredential = 'packed-openai-secret'
export const createPlugin = () => openAiPlugin({ apiKey: expectedCredential })
export const frames = [
  { type: 'response.created', response: { id: 'r1' } },
  { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'i1', delta: 'packed provider completed' },
  { type: 'response.output_item.done', item: { id: 'i1', type: 'message', content: [{ type: 'output_text', text: 'packed provider completed' }] } },
  { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
]
