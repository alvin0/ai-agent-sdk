import { codexPlugin, memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'

export const providerId = 'codex'
export const expectedCredential = 'packed-codex-secret'
export const createPlugin = () => codexPlugin({
  authStore: memoryCodexCredentialStore({
    tokens: { id_token: 'x.y.z', access_token: expectedCredential, refresh_token: 'packed-refresh-secret' },
  }),
  models: [],
})
export const frames = [
  { type: 'response.created', response: { id: 'r1' } },
  { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'i1', delta: 'packed provider completed' },
  { type: 'response.output_item.done', item: { id: 'i1', type: 'message', content: [{ type: 'output_text', text: 'packed provider completed' }] } },
  { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
]
