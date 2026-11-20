import { antigravityPlugin, memoryAntigravityCredentialStore } from '@alvin0/ai-agent-sdk-provider-antigravity'

export const providerId = 'antigravity'
export const expectedCredential = 'packed-antigravity-secret'
export const createPlugin = () => antigravityPlugin({
  models: [{ id: 'packed-model' }],
  authStore: memoryAntigravityCredentialStore({
    version: 1, projectId: 'packed-project', clientId: 'packed-client', obtainedAt: new Date().toISOString(),
    tokens: { access_token: expectedCredential, refresh_token: 'packed-refresh', expires_at: Date.now() + 3_600_000 },
  }),
})
export const frames = [{ response: {
  candidates: [{ content: { parts: [{ text: 'packed provider completed' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
} }]
