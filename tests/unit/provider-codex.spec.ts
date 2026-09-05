import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelRegistry,
  createAgentRuntime,
  createCoreSpan,
  createTextMessage,
  type CaptureReceipt,
  type ObservationEvent,
  type ObservationPort,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import {
  CODEX_BASE_URL,
  codexAdapter,
  codexPlugin,
  memoryCodexAuthStore,
  memoryCodexCredentialStore,
  refreshCodexTokens,
  requestDeviceCode,
  type CodexAuthFile,
  type CodexAuthStore,
} from '@ai-agent-sdk/provider-codex'
import {
  defineCredentialStore,
  type SdkLogger,
} from '@ai-agent-sdk/core/provider'
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

const CODEX_RESPONSES_TEXT = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"ok"}]}}',
]

const codexConformance = officialProviderConformanceFixture({
  family: 'codex',
  model: 'gpt-codex-conformance',
  completeFrames: [...CODEX_RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'],
  missingUsageFrames: [...CODEX_RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1"}}'],
  malformedUsageFrames: [...CODEX_RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}'],
  createAdapter: input => codexAdapter({
    authStore: memoryCodexAuthStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'private-refresh-token',
      },
    }),
    ...input,
  }),
})

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

function recordingPort() {
  const events: ObservationEvent[] = []
  const port: ObservationPort = {
    mode: 'operational',
    openSpan: createCoreSpan,
    capture(event) { events.push(event); return accepted(event) },
  }
  return { events, port }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => vi.unstubAllGlobals())

describe('Universal Codex provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(codexConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

  it('requires an injected auth store and performs no read during construction', () => {
    let reads = 0
    const store: CodexAuthStore = {
      location: '<injected>',
      read: () => { reads++; return Promise.resolve(undefined) },
      write: () => Promise.resolve(),
    }
    const adapter = codexAdapter({ authStore: store, models: [] })
    expect(adapter.providerInfo('codex')).toEqual({ id: 'codex', name: 'Codex' })
    expect(CODEX_BASE_URL).toBe('https://chatgpt.com/backend-api/codex')
    expect(reads).toBe(0)
    expect(() => codexAdapter({} as never)).toThrow(/authStore/i)
  })

  it('rejects an accessor-backed credential marker before getter, store, or network access', () => {
    const markerGetter = vi.fn(() => 'credential-store')
    const read = vi.fn()
    const fetch = vi.fn()
    const store = { id: 'unsafe', label: '<unsafe>', apiVersion: 1, read, commit: vi.fn() }
    Object.defineProperty(store, 'kind', { enumerable: true, get: markerGetter })

    let failure: unknown
    try { codexAdapter({ authStore: store, models: [], fetch } as never) } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'CREDENTIAL_STORE_INVALID' })
    expect(markerGetter).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('captures revisioned store methods once so later replacement cannot redirect credential reads', async () => {
    const file: CodexAuthFile = {
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    }
    const firstRead = vi.fn(() => Promise.resolve({ value: file, revision: '0' }))
    const replacedRead = vi.fn(() => Promise.reject(new Error('replacement must not run')))
    const store = {
      kind: 'credential-store' as const,
      apiVersion: 1 as const,
      id: 'captured-store',
      label: '<captured>',
      read: firstRead,
      commit: vi.fn(() => Promise.resolve({ revision: '1' })),
    }
    const fetch = vi.fn(() => Promise.resolve(sseResponse([
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ])))
    const adapter = codexAdapter({ authStore: store, models: [], fetch })
    store.read = replacedRead

    await drain(adapter.stream({
      provider: 'codex', model: 'gpt-test', messages: [createTextMessage('hello')],
    }))
    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(replacedRead).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses manual redirect mode for OAuth and rejects a redirect before a second request', async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      return Promise.resolve(new Response(null, {
        status: 307,
        headers: { location: 'https://escaped.invalid/device' },
      }))
    })
    await expect(requestDeviceCode({ fetch })).rejects.toThrow(/rejected a redirect/i)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses manual redirect mode for model discovery and never contacts the advertised target', async () => {
    const store = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      return Promise.resolve(new Response(null, {
        status: 307,
        headers: { location: 'https://must-not-be-contacted.invalid/models' },
      }))
    })
    const adapter = codexAdapter({ authStore: store, fetch })

    await expect(adapter.modelCatalog('codex')).rejects.toThrow(/catalog is unavailable/i)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('installs transactionally without reading tokens or discovering the catalog', () => {
    let reads = 0
    const store: CodexAuthStore = {
      location: '<injected>',
      read: () => { reads++; return Promise.resolve(undefined) },
      write: () => Promise.resolve(),
    }
    const registry = new ModelRegistry()
    const dispose = registry.install(codexPlugin({ authStore: store }))
    expect(registry.listProviders()).toEqual([{ id: 'codex', name: 'Codex' }])
    expect(reads).toBe(0)
    dispose()
  })

  it('keeps the memory auth store independent of Node globals', async () => {
    const file = { tokens: { id_token: 'a.b.c', access_token: 'a.b.c', refresh_token: 'r' } }
    const store = memoryCodexAuthStore(file)
    expect(await store.read()).toBe(file)
    const next = { ...file, last_refresh: '2026-09-01T00:00:00.000Z' }
    await store.write(next)
    expect(await store.read()).toBe(next)
  })

  it('provides compare-and-swap memory credentials without exposing mutable store state', async () => {
    const initial: CodexAuthFile = {
      tokens: { id_token: 'old-id', access_token: 'old-access', refresh_token: 'old-refresh' },
    }
    const store = memoryCodexCredentialStore(initial)
    const operation = { signal: new AbortController().signal, logger: NULL_LOGGER }
    const first = await store.read(operation)
    expect(first?.revision).toBe('0')
    if (first === undefined) throw new Error('expected initial credential')
    first.value.tokens!.access_token = 'caller-mutation'
    expect((await store.read(operation))?.value.tokens?.access_token).toBe('old-access')

    await store.commit({
      value: initial,
      expectedRevision: first.revision,
    }, operation)
    await expect(store.commit({
      value: initial,
      expectedRevision: first.revision,
    }, operation)).rejects.toMatchObject({ code: 'CODEX_CREDENTIAL_REVISION_CONFLICT' })
  })

  it('reloads the winning revision when concurrent token refreshes race', async () => {
    const store = memoryCodexCredentialStore({
      auth_mode: 'chatgpt',
      tokens: { id_token: 'old-id', access_token: 'old-access', refresh_token: 'old-refresh' },
    })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const fetch = vi.fn(async () => {
      const number = ++calls
      await barrier
      return Response.json({
        id_token: `new-id-${number}`,
        access_token: `new-access-${number}`,
        refresh_token: `new-refresh-${number}`,
      })
    })

    const first = refreshCodexTokens(store, { fetch })
    const second = refreshCodexTokens(store, { fetch })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect((await store.read({ signal: new AbortController().signal, logger: NULL_LOGGER }))?.value.tokens)
      .toEqual(a)
  })

  it('propagates one operation signal through revisioned reads, refresh, and commit', async () => {
    const oldFile: CodexAuthFile = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: 1 }),
        refresh_token: 'private-old-refresh',
      },
    }
    let current = oldFile
    let revision = 'r0'
    const readSignals: AbortSignal[] = []
    const commitSignals: AbortSignal[] = []
    const store = defineCredentialStore<CodexAuthFile>({
      id: 'signal-store',
      label: 'Signal store',
      async read({ signal }) {
        readSignals.push(signal)
        return { value: current, revision }
      },
      async commit(input, { signal }) {
        commitSignals.push(signal)
        expect(input.expectedRevision).toBe(revision)
        current = input.value
        revision = 'r1'
        return { revision }
      },
    })
    let refreshSignal: AbortSignal | undefined
    const oauthFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      refreshSignal = init?.signal ?? undefined
      return Promise.resolve(Response.json({
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'private-new-refresh',
      }))
    })
    const modelFetch = vi.fn(() => Promise.resolve(sseResponse([
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ])))
    const adapter = codexAdapter({
      authStore: store,
      models: [],
      oauth: { fetch: oauthFetch, requestTimeoutMs: 1_000 },
      fetch: modelFetch,
    })
    const caller = new AbortController()

    await drain(adapter.stream({
      provider: 'codex', model: 'gpt-test', messages: [createTextMessage('hello')],
      signal: caller.signal,
    }))

    expect(readSignals).toHaveLength(2)
    expect(commitSignals).toHaveLength(1)
    expect(readSignals[0]).toBe(readSignals[1])
    expect(commitSignals[0]).toBe(readSignals[0])
    expect(refreshSignal).toBeDefined()
    expect(refreshSignal?.aborted).toBe(false)
    const reason = new Error('caller cancelled operation')
    caller.abort(reason)
    expect(readSignals[0]?.aborted).toBe(true)
    expect(readSignals[0]?.reason).toBe(reason)
    expect(refreshSignal?.aborted).toBe(true)
    expect(refreshSignal?.reason).toBe(reason)
    expect(modelFetch).toHaveBeenCalledTimes(1)
  })

  it('composes a revisioned Codex account with an independent route and default model', async () => {
    const store = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const plugin = codexPlugin({
      id: 'codex-account-a',
      authStore: store,
      models: [],
      defaultModel: 'gpt-account-a',
    })
    expect(plugin).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'codex-account-a',
      family: 'codex', routes: ['codex-account-a'],
      defaultModel: { provider: 'codex-account-a', id: 'gpt-account-a' },
    })

    const runtime = await createAgentRuntime({ providers: [plugin] })
    try {
      expect(runtime.providers()[0]).toMatchObject({
        route: 'codex-account-a', pluginId: 'codex-account-a', family: 'codex',
      })
    } finally {
      await runtime.close()
    }
  })

  it('scopes the default prompt cache key to one provider-plugin instance', async () => {
    const store = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const keys = new Map<string, string[]>()
    const response = () => sseResponse([
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
      'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
      'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"ok"}]}}',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ])
    const fetchFor = (route: string) => vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('session-id')
      if (key === null) throw new Error('missing Codex session-id')
      keys.set(route, [...keys.get(route) ?? [], key])
      return Promise.resolve(response())
    })
    const runtime = await createAgentRuntime({ providers: [
      codexPlugin({ id: 'codex-a', routes: ['account-a'], authStore: store, models: [], fetch: fetchFor('account-a') }),
      codexPlugin({ id: 'codex-b', routes: ['account-b'], authStore: store, models: [], fetch: fetchFor('account-b') }),
    ] })
    try {
      const a = runtime.agent({
        id: 'agent-a', instructions: 'Reply briefly.',
        model: { provider: 'account-a', id: 'gpt-test' }, compaction: false,
      })
      const b = runtime.agent({
        id: 'agent-b', instructions: 'Reply briefly.',
        model: { provider: 'account-b', id: 'gpt-test' }, compaction: false,
      })
      await a.generate('first')
      await a.generate('second')
      await b.generate('first')

      expect(keys.get('account-a')).toHaveLength(2)
      expect(keys.get('account-a')?.[0]).toBe(keys.get('account-a')?.[1])
      expect(keys.get('account-a')?.[0]).not.toBe(keys.get('account-b')?.[0])
    } finally {
      await runtime.close()
    }
  })

  it('uses the injected fetch with revisioned credentials without reading during construction', async () => {
    const store = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    let authorization: string | null = null
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization')
      return Promise.resolve(sseResponse([
        'data: {"type":"response.created","response":{"id":"r1"}}',
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ]))
    })
    const adapter = codexAdapter({ authStore: store, models: [], fetch })
    expect(fetch).not.toHaveBeenCalled()
    const chunks = await drain(adapter.stream({
      provider: 'codex-account', model: 'gpt-test', messages: [createTextMessage('hello')],
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(authorization).toMatch(/^Bearer /)
  })

  it('contains the official endpoint missing-media-type compatibility exception', async () => {
    const store = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const frames = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ]
    const withoutMediaType = () => {
      const response = sseResponse(frames)
      return new Response(response.body, { status: 200 })
    }
    const official = codexAdapter({ authStore: store, models: [], fetch: () => Promise.resolve(withoutMediaType()) })
    expect((await drain(official.stream({
      provider: 'codex', model: 'gpt-test', messages: [createTextMessage('hello')],
    }))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const custom = codexAdapter({
      authStore: store,
      baseUrl: 'https://custom-codex.invalid/backend-api/codex',
      models: [],
      fetch: () => Promise.resolve(withoutMediaType()),
    })
    await expect(drain(custom.stream({
      provider: 'custom', model: 'gpt-test', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: 'HTTP_STREAM_MEDIA_TYPE_INVALID' })

    const wrongType = codexAdapter({
      authStore: store,
      models: [],
      fetch: () => Promise.resolve(new Response('not SSE', {
        status: 200, headers: { 'content-type': 'application/json' },
      })),
    })
    await expect(drain(wrongType.stream({
      provider: 'codex', model: 'gpt-test', messages: [createTextMessage('hello')],
    }))).rejects.toMatchObject({ code: 'HTTP_STREAM_MEDIA_TYPE_INVALID' })
  })

  it('traces credential resolution and refresh without retaining auth or account data', async () => {
    const oldAccess = jwt({ exp: 1 })
    const oldId = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'secret-old-account' },
    })
    const newAccess = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 })
    const newId = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'secret-new-account' },
    })
    const oldRefresh = 'secret-old-refresh-token'
    const newRefresh = 'secret-new-refresh-token'
    let current: CodexAuthFile = {
      tokens: {
        id_token: oldId,
        access_token: oldAccess,
        refresh_token: oldRefresh,
        account_id: 'secret-stored-account',
      },
    }
    const writes: unknown[] = []
    const store: CodexAuthStore = {
      location: '/secret/home/.codex/auth.json',
      read: () => Promise.resolve(current),
      write: file => { writes.push(file); current = file; return Promise.resolve() },
    }
    const oauthFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      id_token: newId,
      access_token: newAccess,
      refresh_token: newRefresh,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sseResponse([
      'data: {"type":"response.created","response":{"id":"r1"}}',
      'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ]))))

    const observed = recordingPort()
    const registry = new ModelRegistry({ observation: observed.port })
    registry.install(codexPlugin({
      authStore: store,
      models: [],
      oauth: { fetch: oauthFetch },
    }))
    const chunks = await drain(registry.stream({
      provider: 'codex',
      model: 'gpt-test',
      messages: [createTextMessage('hello')],
    }))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(oauthFetch).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(1)
    const credentialEvents = observed.events.filter(event => event.name === 'sdk.credential.operation')
    expect(credentialEvents.map(event => [event.phase, event.data.operation, event.data.status])).toEqual([
      ['start', 'resolve', undefined],
      ['start', 'refresh', undefined],
      ['end', 'refresh', 'success'],
      ['end', 'resolve', 'success'],
    ])
    const serialized = JSON.stringify(credentialEvents)
    for (const sensitive of [
      oldAccess, oldId, oldRefresh, newAccess, newId, newRefresh,
      'secret-old-account', 'secret-new-account', 'secret-stored-account',
      '/secret/home/.codex/auth.json',
    ]) expect(serialized).not.toContain(sensitive)
  })
})
