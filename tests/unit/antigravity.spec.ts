import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, createAssistantMessage, createUserMessage, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import {
  antigravityAdapter, antigravityPlugin, completeAntigravityLogin, createAntigravityAuthorization,
  createAntigravityCredentialResolver, memoryAntigravityCredentialStore,
  serializeAntigravityRequest, translateAntigravityStream, type AntigravityAuthFile,
} from '../../packages/provider-antigravity/src/index.ts'
import { NULL_LOGGER, requestJson } from '../../packages/provider-antigravity/src/http.ts'
import type { ProtocolRequest } from '@alvin0/ai-agent-sdk-provider-http'

const operation = () => ({ signal: new AbortController().signal, logger: NULL_LOGGER })
const file = (extra: Partial<AntigravityAuthFile> = {}): AntigravityAuthFile => ({
  version: 1, tokens: { access_token: 'test-access-secret', refresh_token: 'test-refresh-secret', expires_at: Date.now() + 3_600_000 },
  projectId: 'account-project', clientId: 'test-client', obtainedAt: new Date().toISOString(), ...extra,
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})
const frame = (text = 'hello') => ({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } })
const stream = (...frames: unknown[]) => new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
})
const events = async function* (...values: unknown[]) { for (const value of values) yield { event: undefined, data: JSON.stringify(value) } }
const collect = async <T>(source: AsyncIterable<T>) => { const output: T[] = []; for await (const value of source) output.push(value); return output }
const request = (overrides: Partial<ProtocolRequest['options']> = {}): ProtocolRequest => ({
  options: { provider: 'antigravity', model: 'gemini-account-model', messages: [], ...overrides },
  model: { provider: 'antigravity', id: 'gemini-account-model', name: 'model' }, connection: {} as ProtocolRequest['connection'],
})

describe('Antigravity OAuth', () => {
  it('requires an externally supplied client instead of selecting an embedded client', async () => {
    await expect(createAntigravityAuthorization({ redirectUri: 'http://localhost:51121/oauth-callback' }))
      .rejects.toMatchObject({ code: 'ANTIGRAVITY_CLIENT_REQUIRED' })
  })

  it('creates random state and S256 PKCE without putting the verifier into state', async () => {
    const auth = await createAntigravityAuthorization({ clientId: 'test-client', redirectUri: 'http://localhost:51121/oauth-callback' })
    const second = await createAntigravityAuthorization({ clientId: 'test-client', redirectUri: auth.redirectUri })
    const url = new URL(auth.url)
    expect(auth.state).not.toBe(second.state)
    expect(auth.url).not.toContain(auth.verifier)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth.verifier))
    expect(url.searchParams.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'))
    expect(url.searchParams.get('access_type')).toBe('offline')
    await expect(createAntigravityAuthorization({ clientId: 'test-client', redirectUri: 'http://evil.invalid/callback' })).rejects.toThrow('loopback')
  })

  it('commits only after code exchange, project discovery and account identity succeed', async () => {
    const store = memoryAntigravityCredentialStore()
    const auth = await createAntigravityAuthorization({ clientId: 'test-client', redirectUri: 'http://localhost:51121/oauth-callback' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('code_verifier')).toBe(auth.verifier)
        expect(body.get('client_id')).toBe('test-client')
        expect(init?.redirect).toBe('manual')
        return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
      }
      if (url.includes('loadCodeAssist')) return json({ cloudaicompanionProject: { id: 'real-project' } })
      return json({ email: 'user@example.test' })
    })
    const params = new URLSearchParams({ code: 'authorization-code', state: auth.state })
    await expect(completeAntigravityLogin(store, auth, params, { fetch: fetcher })).resolves.toEqual({
      projectId: 'real-project', account: { email: 'user@example.test' },
    })
    expect((await store.read(operation()))?.value.tokens.refresh_token).toBe('new-refresh')
    await expect(completeAntigravityLogin(store, auth, params, { fetch: fetcher })).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_STATE_INVALID' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('rejects forged, duplicate and declined callbacks without changing existing credentials', async () => {
    const store = memoryAntigravityCredentialStore(file())
    const auth = await createAntigravityAuthorization({ clientId: 'test-client', redirectUri: 'http://localhost:51121/oauth-callback' })
    const fetcher = vi.fn<typeof fetch>()
    for (const params of [new URLSearchParams({ state: 'wrong', code: 'code' }),
      new URLSearchParams(`state=${auth.state}&state=${auth.state}&code=code`)]) {
      await expect(completeAntigravityLogin(store, auth, params, { fetch: fetcher })).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_STATE_INVALID' })
    }
    await expect(completeAntigravityLogin(store, auth, new URLSearchParams({ state: auth.state, error: 'access_denied' }),
      { fetch: fetcher })).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_DENIED' })
    expect(fetcher).not.toHaveBeenCalled()
    expect((await store.read(operation()))?.value.projectId).toBe('account-project')
  })

  it('does not commit incomplete credentials or expose provider bodies and fetch errors', async () => {
    const store = memoryAntigravityCredentialStore()
    const auth = await createAntigravityAuthorization({ clientId: 'test-client', redirectUri: 'http://localhost:51121/oauth-callback' })
    await expect(completeAntigravityLogin(store, auth, new URLSearchParams({ state: auth.state, code: 'code' }), {
      fetch: async () => json({ access_token: 'secret', expires_in: 3600 }),
    })).rejects.toThrow('refresh token')
    expect(await store.read(operation())).toBeUndefined()
    await expect(requestJson('https://test.invalid', {}, { fetch: async () => {
      throw new Error('token=secret-do-not-print')
    } })).rejects.toThrow('Antigravity request failed')
    await expect(requestJson('https://test.invalid', {}, { fetch: async () => json({ error: 'secret' }, 403) }))
      .rejects.toMatchObject({ message: 'Antigravity request failed (HTTP 403)', code: 'ANTIGRAVITY_ACCESS_DENIED' })
  })

  it('bounds hanging fetches, oversized JSON, and redirects', async () => {
    await expect(requestJson('https://test.invalid', {}, { requestTimeoutMs: 10,
      fetch: () => new Promise(() => undefined) })).rejects.toThrow('timed out')
    await expect(requestJson('https://test.invalid', {}, { maxResponseBytes: 5,
      fetch: async () => json({ too: 'large' }) })).rejects.toThrow('limits')
    await expect(requestJson('https://test.invalid', {}, { fetch: async () => new Response(null, {
      status: 302, headers: { location: 'https://other.invalid' },
    }) })).rejects.toThrow('HTTP 302')
  })

  it('serializes refreshes and preserves refresh tokens omitted by Google', async () => {
    const store = memoryAntigravityCredentialStore(file({ tokens: { ...file().tokens, expires_at: 0 } }))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'fresh', expires_in: 3600 }))
    const resolve = createAntigravityCredentialResolver(store, { fetch: fetcher })
    const results = await Promise.all(Array.from({ length: 8 }, () => resolve(operation())))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(results.every(value => value.tokens.access_token === 'fresh')).toBe(true)
    expect((await store.read(operation()))?.value.tokens.refresh_token).toBe('test-refresh-secret')
  })

  it('does not overwrite a concurrent login when refresh finishes later', async () => {
    const store = memoryAntigravityCredentialStore(file({ tokens: { ...file().tokens, expires_at: 0 } }))
    let release!: (value: Response) => void
    const resolve = createAntigravityCredentialResolver(store, { fetch: () => new Promise(done => { release = done }) })
    const pending = resolve(operation())
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    const previous = await store.read(operation())
    await store.commit({ expectedRevision: previous!.revision, value: file({ projectId: 'new-login-project' }) }, operation())
    release(json({ access_token: 'stale-result', expires_in: 3600 }))
    expect((await pending).projectId).toBe('new-login-project')
    expect((await store.read(operation()))?.value.tokens.access_token).not.toBe('stale-result')
  })
})

describe('Antigravity provider', () => {
  it('runs through the real SDK runtime and uses the exact model, project and bearer token', async () => {
    const seen: Record<string, unknown>[] = []
    const runtime = await createAgentRuntime({ providers: [antigravityPlugin({
      authStore: memoryAntigravityCredentialStore(file()), models: [{ id: 'new-account-model' }],
      fetch: async (input, init) => {
        expect(String(input)).toContain('/v1internal:streamGenerateContent?alt=sse')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-secret')
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return stream(frame('runtime answer'))
      },
    })] })
    try {
      const result = await runtime.agent({ id: 'test-antigravity', instructions: 'Answer the user.', model: { provider: 'antigravity', id: 'new-account-model' }, compaction: false }).generate('hello')
      expect(result.text).toBe('runtime answer')
      expect(result.usage.reported.totalTokens).toBe(12)
      expect(seen[0]).toMatchObject({ model: 'new-account-model', project: 'account-project', requestType: 'agent' })
      const diagnostics = JSON.stringify(runtime.diagnostics().events)
      expect(diagnostics).not.toContain('test-access-secret')
      expect(runtime.diagnostics().events.filter(event => event.name === 'sdk.credential.operation')).toHaveLength(2)
    } finally { await runtime.close() }
  })

  it('discovers account models, caches by credential identity and never requires catalog membership', async () => {
    const store = memoryAntigravityCredentialStore(file())
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ models: {
      'live-model': { displayName: 'Live model', maxTokens: 128000, maxOutputTokens: 8192 },
      internal: { isInternal: true }, disabled: { disabled: true },
    } }))
    const adapter = antigravityAdapter({ authStore: store, fetch: fetcher })
    expect((await adapter.listModels('antigravity')).map(model => model.id)).toEqual(['live-model'])
    expect((await adapter.resolveModel('antigravity', 'unlisted-model')).id).toBe('unlisted-model')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const previous = await store.read(operation())
    await store.commit({ expectedRevision: previous!.revision,
      value: file({ tokens: { ...file().tokens, refresh_token: 'new-account-refresh' } }) }, operation())
    await adapter.listModels('antigravity')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fails clearly without credentials and does not invoke store getters during construction', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(antigravityAdapter({ authStore: memoryAntigravityCredentialStore(), fetch: fetcher })
      .listModels('antigravity')).rejects.toThrow('ai-agent-sdk-antigravity-login')
    expect(fetcher).not.toHaveBeenCalled()
    const getter = vi.fn()
    const store = Object.defineProperty({}, 'kind', { get: getter })
    expect(() => antigravityAdapter({ authStore: store as never })).toThrow('accessors')
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves signed reasoning and function-call metadata for the next tool turn', async () => {
    const chunks = await collect(translateAntigravityStream(events({ response: { candidates: [{ content: { parts: [
      { thought: true, text: 'thinking', thoughtSignature: 'thought-signature' },
      { functionCall: { name: 'lookup', args: { city: 'Hue' } }, thoughtSignature: 'call-signature' },
    ] }, finishReason: 'STOP' }] } })))
    const content = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const finish = chunks.find(chunk => chunk.type === 'finish')!
    expect(finish).toMatchObject({ reason: { kind: 'tool-calls' } })
    const call = content.find(block => block.type === 'tool-call')!
    const assistant = createAssistantMessage({ content, source: { provider: 'antigravity', model: 'm', replayState: finish.replayState } })
    const result = createUserMessage({ source: { kind: 'tool', callId: call.id }, content: [
      { type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'sunny' }] },
    ] })
    const wire = serializeAntigravityRequest(request({ messages: [assistant, result] }))
    expect(wire).toMatchObject({ contents: [
      { role: 'model', parts: [ { thoughtSignature: 'thought-signature' }, { thoughtSignature: 'call-signature' } ] },
      { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { output: 'sunny' } } }] },
    ] })
  })

  it('maps cumulative cache and reasoning usage without double counting', async () => {
    const chunks = await collect(translateAntigravityStream(events({ response: { candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 7, totalTokenCount: 30 } } })))
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: {
      inputTokens: 15, cacheReadTokens: 5, outputTokens: 10, reasoningTokens: 7, totalTokens: 30,
    } })
  })

  it('rejects truncated, malformed, blocked, and late-content streams', async () => {
    await expect(collect(translateAntigravityStream(events({ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } }))))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    await expect(collect(translateAntigravityStream(events(frame(), frame('late'))))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect(translateAntigravityStream(events({ response: { candidates: [{ finishReason: 'SAFETY' }] } }))))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(collect(translateAntigravityStream((async function* () { yield { event: undefined, data: 'not json' } })())))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('sends function declarations, tool choice, system and JSON output; rejects unsupported content', () => {
    const wire = serializeAntigravityRequest(request({ system: 'system', tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'lookup' }, outputFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
    }))
    expect(wire).toMatchObject({ systemInstruction: { parts: [{ text: 'system' }] },
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'object' } }, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } } })
    expect(wire.generationConfig).not.toHaveProperty('responseJsonSchema')
    expect(() => serializeAntigravityRequest(request({ tools: [{ type: 'native', name: 'web-search' }] }))).toThrow('native')
    expect(() => serializeAntigravityRequest(request({ messages: [createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'tool-result', toolCallId: ToolCallId('missing'), content: [] }],
    })] }))).toThrow('matching function')
  })
})
