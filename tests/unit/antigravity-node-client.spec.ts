import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  antigravityNodeAdapter, memoryAntigravityCredentialStore, runAntigravityBrowserLogin,
} from '@alvin0/ai-agent-sdk-auth-node/antigravity'
import { withAntigravityOAuthEnvironment } from '../../packages/auth-node/src/antigravity-oauth.ts'

afterEach(() => vi.unstubAllEnvs())

describe('Antigravity external OAuth client', () => {
  it('uses Node environment defaults and preserves explicit client options', () => {
    const env = { AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID: 'environment-client',
      AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET: 'environment-secret' }
    expect(withAntigravityOAuthEnvironment({}, env)).toEqual({
      clientId: 'environment-client', clientSecret: 'environment-secret',
    })
    expect(withAntigravityOAuthEnvironment({ clientId: 'explicit-client', clientSecret: 'explicit-secret' }, env))
      .toEqual({ clientId: 'explicit-client', clientSecret: 'explicit-secret' })
    expect(withAntigravityOAuthEnvironment({}, {})).toEqual({})
    expect(withAntigravityOAuthEnvironment({ clientId: 'another-client' }, env))
      .toEqual({ clientId: 'another-client' })
  })

  it('refreshes existing project credentials using the externally supplied secret', async () => {
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID', 'fixture-client')
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET', 'external-refresh-secret')
    const store = memoryAntigravityCredentialStore({ version: 1, clientId: 'fixture-client',
      projectId: 'fixture-project', obtainedAt: new Date().toISOString(),
      tokens: { access_token: 'expired', refresh_token: 'refresh', expires_at: 0 } })
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe('fixture-client')
      expect(body.get('client_secret')).toBe('external-refresh-secret')
      return Response.json({ access_token: 'fresh', expires_in: 3600 })
    })
    await expect(antigravityNodeAdapter({ authStore: store, models: [], fetch }).listModels('antigravity'))
      .resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing client before showing a browser prompt and closes its listener', async () => {
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID', '')
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET', '')
    const onPrompt = vi.fn()
    await expect(runAntigravityBrowserLogin(memoryAntigravityCredentialStore(), { port: 0 }, { onPrompt }))
      .rejects.toMatchObject({ code: 'ANTIGRAVITY_CLIENT_REQUIRED' })
    expect(onPrompt).not.toHaveBeenCalled()
  })
})
