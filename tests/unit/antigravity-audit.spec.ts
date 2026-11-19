import { describe, expect, it, vi } from 'vitest'
import { defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import { createAssistantMessage, createTextMessage, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from '@alvin0/ai-agent-sdk-provider-http'
import {
  completeAntigravityLogin, createAntigravityAuthorization, createAntigravityCredentialResolver, memoryAntigravityCredentialStore, serializeAntigravityRequest,
  type AntigravityAuthFile,
} from '../../packages/provider-antigravity/src/index.ts'
import { abortable, NULL_LOGGER, requestJson } from '../../packages/provider-antigravity/src/http.ts'

const file = (): AntigravityAuthFile => ({ version: 1, projectId: 'fixture-project', clientId: 'fixture-client',
  obtainedAt: new Date().toISOString(), tokens: { access_token: 'test-access', refresh_token: 'test-refresh',
    expires_at: Date.now() + 3_600_000 } })
const operation = (signal = new AbortController().signal) => ({ signal, logger: NULL_LOGGER })

describe('Antigravity cancellation and credential boundaries', () => {
  it('does not start HTTP work for an already aborted request', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(requestJson('https://fixture.test', {}, { fetch, signal: controller.signal })).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
    await expect(abortable(Promise.reject(new Error('late rejection')), controller.signal)).rejects.toBe(reason)
  })

  it('cancels an HTTP response arriving after the request deadline', async () => {
    let deliver!: (response: Response) => void
    const cancel = vi.fn()
    const fetch = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve }))
    await expect(requestJson('https://fixture.test', {}, { fetch, requestTimeoutMs: 10 })).rejects.toThrow('timed out')
    deliver(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
  })

  it('does not accept an injected fetch that returns a followed redirect', async () => {
    const response = Response.json({ access_token: 'never-accept' })
    Object.defineProperty(response, 'redirected', { value: true })
    await expect(requestJson('https://fixture.test', {}, { fetch: async () => response }))
      .rejects.toThrow('redirected response')
  })

  it('releases the refresh queue when an uncooperative store read is cancelled', async () => {
    let reads = 0
    const store = defineCredentialStore<AntigravityAuthFile>({ id: 'fixture', label: 'fixture',
      read: async () => ++reads === 1 ? new Promise(() => {}) : { value: file(), revision: 'current' },
      commit: async () => ({ revision: 'unused' }),
    })
    const resolve = createAntigravityCredentialResolver(store, {})
    const controller = new AbortController()
    const pending = resolve(operation(controller.signal))
    const reason = new Error('cancel store read')
    const rejected = expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(reads).toBe(1))
    controller.abort(reason)
    await rejected
    await expect(resolve(operation())).resolves.toMatchObject({ projectId: 'fixture-project' })
    expect(reads).toBe(2)
  })

  it('cancels a queued resolver independently of the request holding the refresh queue', async () => {
    const current = file()
    const store = memoryAntigravityCredentialStore({ ...current, tokens: { ...current.tokens, expires_at: 0 } })
    const owner = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const resolve = createAntigravityCredentialResolver(store, { fetch })
    const first = resolve(operation(owner.signal))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const waiter = new AbortController()
    const second = resolve(operation(waiter.signal))
    waiter.abort('waiting cancelled')
    await expect(second).rejects.toBe('waiting cancelled')
    owner.abort('owner cancelled')
    await expect(first).rejects.toBe('owner cancelled')
  })

  it.each(['read', 'commit'])('cancels login when the custom store hangs in %s', async phase => {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const hang = () => { markStarted(); return new Promise<never>(() => {}) }
    const store = defineCredentialStore<AntigravityAuthFile>({ id: 'login-test', label: 'test',
      read: async () => phase === 'read' ? hang() : undefined, commit: hang })
    const auth = await createAntigravityAuthorization({ clientId: 'fixture', redirectUri: 'http://localhost:51121/' })
    const controller = new AbortController()
    const pending = completeAntigravityLogin(store, auth, new URLSearchParams({ state: auth.state, code: 'fixture' }), {
      signal: controller.signal, fetch: async url => Response.json(String(url).includes('/token')
        ? { access_token: 'a', refresh_token: 'r', expires_in: 3600 } : { cloudaicompanionProject: 'p' }) })
    await started
    controller.abort('cancel login')
    await expect(pending).rejects.toBe('cancel login')
  })

  it('rejects a winning concurrent login under another explicitly configured OAuth client', async () => {
    const value = file()
    const store = memoryAntigravityCredentialStore({ ...value, tokens: { ...value.tokens, expires_at: 0 } })
    let deliver!: (response: Response) => void
    const resolve = createAntigravityCredentialResolver(store, { clientId: value.clientId,
      fetch: () => new Promise<Response>(done => { deliver = done }),
    })
    const pending = resolve(operation())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_INVALID' })
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
    const previous = await store.read(operation())
    await store.commit({ expectedRevision: previous!.revision, value: { ...file(), clientId: 'different-client' } },
      operation())
    deliver(Response.json({ access_token: 'stale-refresh-result', expires_in: 3600 }))
    await rejected
    expect((await store.read(operation()))?.value.clientId).toBe('different-client')
  })

  it('omits trailing empty text parts from Claude tool-call replay without dropping the call', () => {
    const assistant = createAssistantMessage({ source: { provider: 'antigravity', model: 'claude-sonnet-4-6' },
      content: [{ type: 'text', text: 'Calling the tool.' },
        { type: 'tool-call', id: ToolCallId('call'), name: 'lookup', arguments: '{}' }, { type: 'text', text: '' }],
    })
    const wire = serializeAntigravityRequest({
      options: { provider: 'antigravity', model: 'claude-sonnet-4-6', messages: [createTextMessage('Look up.'), assistant] },
      model: { provider: 'antigravity', id: 'claude-sonnet-4-6', name: 'Claude' },
      connection: {} as ProtocolRequest['connection'],
    })
    expect(wire).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'Look up.' }] },
      { role: 'model', parts: [{ text: 'Calling the tool.' },
        { functionCall: { name: 'lookup', id: 'call', args: {} } }] }] })
  })
})
