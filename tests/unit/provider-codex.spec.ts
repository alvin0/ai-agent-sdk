import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelRegistry,
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
  type CodexAuthFile,
  type CodexAuthStore,
} from '@ai-agent-sdk/provider-codex'

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

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
