import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

export const providerId = 'anthropic'
export const expectedCredential = 'packed-anthropic-secret'
export const createPlugin = () => anthropicPlugin({ apiKey: expectedCredential })
export const frames = [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'packed provider completed' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]
