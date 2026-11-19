import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, createAssistantMessage, createUserMessage, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import {
  antigravityAdapter, antigravityPlugin, completeAntigravityLogin, createAntigravityAuthorization,
  createAntigravityCredentialResolver, memoryAntigravityCredentialStore, resolveAntigravityProject,
  serializeAntigravityRequest, translateAntigravityStream, type AntigravityAuthFile,
} from '../../packages/provider-antigravity/src/index.ts'
import { NULL_LOGGER, requestJson } from '../../packages/provider-antigravity/src/http.ts'
import type { ProtocolRequest, ProtocolStreamChunk } from '@alvin0/ai-agent-sdk-provider-http'

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
  it('starts onboarding once and polls the returned operation on the same service', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ allowedTiers: [{ isDefault: true, id: 'tier' }] }))
      .mockResolvedValueOnce(json({ name: 'operations/fixture' }))
      .mockResolvedValueOnce(json({ done: true, response: { cloudaicompanionProject: { id: 'created' } } }))
    await expect(resolveAntigravityProject('test', { fetch, baseUrl: 'https://fixture.test' })).resolves.toBe('created')
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://fixture.test/v1internal:loadCodeAssist', 'POST'], ['https://fixture.test/v1internal:onboardUser', 'POST'],
      ['https://fixture.test/v1internal/operations/fixture', 'GET'],
    ])
  })

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
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      createAntigravityCredentialResolver({ ...store }, { fetch: fetcher })(operation())))
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
    await expect(pending).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_INVALID' })
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

  it.each([false, true])('normalizes counters split across SSE frames in either order (reverse=%s)', async reverse => {
    const counts = [{ promptTokenCount: 50, candidatesTokenCount: 3 },
      { cachedContentTokenCount: 10, thoughtsTokenCount: 2, totalTokenCount: 55 }]
    const frames = (reverse ? counts.reverse() : counts).map(usageMetadata => ({ usageMetadata }))
    const chunks = await collect(translateAntigravityStream(events(...frames, {
      usageMetadata: { candidatesTokenCount: 4, totalTokenCount: 56 }, candidates: [{ finishReason: 'STOP' }],
    })))
    expect(chunks.filter(chunk => chunk.type === 'usage-progress')[1]).toMatchObject({ usage: {
      inputTokens: 40, outputTokens: 5, cacheReadTokens: 10, reasoningTokens: 2, totalTokens: 55,
    } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: {
      inputTokens: 40, outputTokens: 6, cacheReadTokens: 10, reasoningTokens: 2, totalTokens: 56,
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

  it('retains cumulative usage on EOF and classifies an empty blocked candidate list', async () => {
    const data = { candidates: [], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 } }
    const chunks: ProtocolStreamChunk[] = []
    const read = async () => {
      for await (const chunk of translateAntigravityStream(events(data, data))) chunks.push(chunk)
    }
    await expect(read()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect(chunks).toEqual(Array(2).fill({ type: 'usage-progress', usage: { inputTokens: 50, outputTokens: 1 } }))
    await expect(collect(translateAntigravityStream(events({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }))))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('reports the usage observed before a truncated response through the public runtime', async () => {
    const incomplete = { candidates: [{ content: { parts: [{ text: 'partial' }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 } }
    const runtime = await createAgentRuntime({ providers: [antigravityPlugin({ authStore: memoryAntigravityCredentialStore(file()),
      models: [{ id: 'm' }], fetch: async () => stream(incomplete, { usageMetadata: incomplete.usageMetadata }) })] })
    try {
      const result = runtime.agent({ id: 'eof', instructions: 'Answer.', model: { provider: 'antigravity', id: 'm' } })
        .createSession().run('Hello.')
      await expect(result).rejects.toMatchObject({ code: 'STREAM_CLOSED',
        report: { usage: { reported: { inputTokens: 50, outputTokens: 1 } } } })
    } finally { await runtime.close() }
  })

  it('uses a stable upstream id per agent session and respects provider cancellation', async () => {
    const ids: string[] = []
    const controller = new AbortController()
    const runtime = await createAgentRuntime({ providers: [antigravityPlugin({ authStore: memoryAntigravityCredentialStore(file()),
      models: [{ id: 'm' }], signal: controller.signal, fetch: async (_url, init) => {
        ids.push(JSON.parse(String(init?.body)).request.sessionId)
        return stream(frame())
      } })] })
    try {
      const agent = runtime.agent({ id: 'sessions', instructions: 'Answer.', model: { provider: 'antigravity', id: 'm' } })
      const one = agent.createSession()
      await one.run('First.')
      await one.run('Next.')
      await agent.createSession().run('New.')
      expect(ids).toHaveLength(3)
      expect(ids[1]).toBe(ids[0])
      expect(ids[2]).not.toBe(ids[0])
      controller.abort()
      await agent.createSession().run('Cancelled.').catch(() => undefined)
      expect(ids).toHaveLength(3)
    } finally { await runtime.close() }
  })

  it('keeps routing fields private and merges agent options on individual requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => stream(frame()))
    const adapter = antigravityAdapter({ authStore: memoryAntigravityCredentialStore(file()), models: [], fetch })
    const options = request({ temperature: 0.7, topP: 0.9 }).options
    await collect(adapter.stream(options, { providerOptions: { headers: { 'X-Trace': 'trace' },
      body: { labels: { fixture: 'one' }, generationConfig: { temperature: 0.2, topP: null } } } }))
    await collect(adapter.stream(options))
    const [one, two] = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).request)
    expect(one).toMatchObject({ labels: { fixture: 'one' }, generationConfig: { temperature: 0.2 } })
    expect(one.generationConfig).not.toHaveProperty('topP')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-trace')).toBe('trace')
    expect(two).not.toHaveProperty('labels')
    expect(two.generationConfig).toMatchObject({ temperature: 0.7, topP: 0.9 })
    await expect(collect(adapter.stream(options, { providerOptions: { headers: { 'x-api-key': 'private' } } })))
      .rejects.toThrow(/credential headers/i)
    await expect(collect(adapter.stream(options, { providerOptions: { body: { project: 'other' } } }))).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('replays the signature on its original empty text part', async () => {
    const parts = [{ text: 'answer' }, { text: '', thoughtSignature: 'signature' }]
    const chunks = await collect(translateAntigravityStream(events({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })))
    const content = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const finish = chunks.find(chunk => chunk.type === 'finish')!
    const assistant = createAssistantMessage({ content, source: { provider: 'antigravity', model: 'm', replayState: finish.replayState } })
    expect(serializeAntigravityRequest(request({ messages: [assistant] })).contents).toEqual([{ role: 'model', parts }])
  })

  it('preserves tool JSON Schema and expands structured output references in nested schema positions', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', items: { $ref: '#/$defs/entry' } } }, $defs: { entry: { type: 'string' } } }
    const format = { type: 'json_schema' as const, name: 'answer', schema }
    const wire = serializeAntigravityRequest(request({ tools: [{ name: 'record', description: 'Record', parameters: schema }],
      outputFormat: format }))
    expect(wire.tools).toMatchObject([{ functionDeclarations: [{ parametersJsonSchema: schema }] }])
    expect(wire.generationConfig).toMatchObject({ responseSchema: { type: 'object', additionalProperties: false,
      required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } } })
    for (const ref of ['https://external.test/schema', '#/$defs/missing', '#/$defs/loop']) {
      expect(() => serializeAntigravityRequest(request({ outputFormat: { ...format,
        schema: { $ref: ref, $defs: { loop: { $ref: '#/$defs/loop' } } } } }))).toThrow(/response schema/)
    }
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
