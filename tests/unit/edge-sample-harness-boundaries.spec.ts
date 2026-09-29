import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEdgeChatApp } from '../../samples/edge-runtime-chat-agents/web/src/server/app.ts'
import { activeSessions, dropSession, findSession } from '../../samples/edge-runtime-chat-agents/web/src/server/sessions.ts'

const KEY = 'sk-edge-harness-fixture'
const MODEL = 'gpt-edge-fixture'
const catalog = [{ id: MODEL, contextWindow: 128000, maxOutputTokens: 4096, efforts: ['low', 'high'] }]
const slots = new Set<string>()
const responses: Response[] = []
const releases: (() => void)[] = []
const calls: { url: string; body: Record<string, unknown> }[] = []
let held = false, failure = false

function providerBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    const finish = () => {
      const frames = [
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
        { type: 'response.output_text.delta', item_id: 'i1', delta: 'verified' },
        { type: 'response.output_item.done', item: { id: 'i1', type: 'message', content: [{ type: 'output_text', text: 'verified' }] } },
        { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } },
      ]
      try { controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))); controller.close() }
      catch { /* SDK cancellation already closed this fixture stream. */ }
    }
    if (held) releases.push(finish)
    else finish()
  } })
}

beforeEach(() => {
  calls.length = 0; responses.length = 0; releases.length = 0; slots.clear(); held = false; failure = false
  vi.stubEnv('OPENAI_API_KEY', KEY); vi.stubEnv('EDGE_CHAT_MODEL', MODEL)
  vi.stubEnv('EDGE_CHAT_EFFORT', ''); vi.stubEnv('EDGE_CHAT_MODE', 'single')
  vi.stubEnv('OPENAI_BASE_URL', ''); vi.stubEnv('EDGE_CHAT_MAX_SESSIONS', '24')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return failure
      ? new Response(JSON.stringify({ error: { message: 'Fixture model unavailable' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      : new Response(providerBody(), { headers: { 'content-type': 'text/event-stream' } })
  }))
})

afterEach(async () => {
  held = false
  releases.splice(0).forEach(release => release())
  await Promise.allSettled(responses.map(response => response.bodyUsed ? Promise.resolve() : response.text()))
  await Promise.all([...slots].flatMap(id => [KEY, 'sk-edge-other-fixture'].map(key => dropSession(id, key))))
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function chat(id: string, overrides: Record<string, unknown> = {}, key = KEY, signal?: AbortSignal): Promise<Response> {
  slots.add(id)
  const response = await createEdgeChatApp().fetch(new Request('https://edge.test/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': key },
    body: JSON.stringify({ conversationId: id, message: 'Read this public fixture.', model: MODEL, catalog, ...overrides }),
    ...(signal === undefined ? {} : { signal }),
  }))
  responses.push(response)
  return response
}

async function wire(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text()
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

describe('Edge sample actual harness admission and terminal boundaries', () => {
  it('admits one simultaneous first request per conversation', async () => {
    synchronizeDigests()
    held = true
    const pair = await Promise.all([chat('edge-race'), chat('edge-race')])
    expect(pair.map(response => response.status).sort()).toEqual([200, 409])
    expect(activeSessions()).toBe(1)
    releases.splice(0).forEach(release => release())
  })

  it('counts pending constructions against isolate capacity', async () => {
    synchronizeDigests()
    held = true; vi.stubEnv('EDGE_CHAT_MAX_SESSIONS', '1')
    const pair = await Promise.all([chat('edge-cap-one'), chat('edge-cap-two')])
    expect(pair.map(response => response.status).sort()).toEqual([200, 503])
    expect(activeSessions()).toBe(1)
    releases.splice(0).forEach(release => release())
  })

  it('refuses an effort change while the original response is active', async () => {
    held = true
    await chat('edge-busy-config')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const first = await findSession('edge-busy-config', KEY)
    const second = await chat('edge-busy-config', { effort: 'high' })
    expect(second.status).toBe(409)
    expect(await findSession('edge-busy-config', KEY)).toBe(first)
    expect(calls).toHaveLength(1)
    releases.splice(0).forEach(release => release())
  })

  it.each(['single', 'team', 'team-auto'])('reports provider failure as one error terminal in %s', async mode => {
    failure = true
    const events = await wire(await chat(`edge-fail-${mode}`, { mode }))
    const terminals = events.filter(event => event.t === 'done' || event.t === 'error')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ t: 'error', status: 400, detail: 'Fixture model unavailable' })
  })

  it('does not dispatch a request that arrived already aborted', async () => {
    const abort = new AbortController(); abort.abort('fixture disconnected')
    const events = await wire(await chat('edge-pre-abort', {}, KEY, abort.signal))
    expect(calls).toHaveLength(0)
    expect(events.filter(event => event.t === 'done')).toHaveLength(0)
  })

  it('keeps the replacement user input in the actual request after provider failure', async () => {
    failure = true
    await wire(await chat('edge-recovery-input', { message: 'FIRST_FAILED_INPUT' }))
    failure = false
    const recovered = await wire(await chat('edge-recovery-input', { message: 'REPLACEMENT_USER_INPUT' }))
    expect(recovered.at(-1)?.t).toBe('done')
    const request = JSON.stringify(calls.at(-1)?.body)
    expect(request).toContain('REPLACEMENT_USER_INPUT')
    expect(request.indexOf('REPLACEMENT_USER_INPUT')).toBeGreaterThan(request.lastIndexOf('FIRST_FAILED_INPUT'))
  })

  it('rebinds changed host instructions and endpoint between idle turns', async () => {
    vi.stubEnv('EDGE_CHAT_INSTRUCTIONS', 'First public host instruction.')
    await wire(await chat('edge-rebind'))
    vi.stubEnv('EDGE_CHAT_INSTRUCTIONS', 'Second public host instruction.')
    vi.stubEnv('OPENAI_BASE_URL', 'https://second-provider.test/v1')
    await wire(await chat('edge-rebind'))
    expect(JSON.stringify(calls[1]?.body)).toContain('Second public host instruction.')
    expect(calls[1]?.url).toContain('second-provider.test')
  })

  it('starts independent auto workers from their assigned task without copying the whole chat', async () => {
    const id = 'edge-fresh-worker'; slots.add(id)
    const { acquireSession } = await import('../../samples/edge-runtime-chat-agents/web/src/server/sessions.ts')
    const { readConfig } = await import('../../samples/edge-runtime-chat-agents/web/src/server/config.ts')
    const entry = await acquireSession(id, readConfig(process.env, KEY, { mode: 'team-auto', model: MODEL, catalog }))
    const managed = entry.managedTeam!
    await managed.lead.run('LEAD_CONTEXT_CANARY_ONLY')
    const previous = calls.length
    await managed.spawn({ name: 'fresh-worker', task: 'ASSIGNED_WORKER_TASK', role: 'analyst' })
    await managed.whenQuiet()
    expect(calls.length).toBeGreaterThan(previous)
    const workerRequests = JSON.stringify(calls.slice(previous))
    expect(workerRequests).toContain('ASSIGNED_WORKER_TASK')
    expect(workerRequests).not.toContain('LEAD_CONTEXT_CANARY_ONLY')
  })

  it('scopes history, traces and close to the supplied credential', async () => {
    const first = await wire(await chat('edge-owner', { message: 'PRIVATE/owner%canary' }))
    const runId = first.find(event => event.t === 'start')?.runId
    expect(typeof runId).toBe('string')
    const owner = await createEdgeChatApp().fetch(new Request(`https://edge.test/api/traces/${String(runId)}`, { headers: { 'x-openai-key': KEY } }))
    const own = await owner.json() as { spans: { kind: string; status: string; durationMs: number | null }[] }
    expect(own.spans.length).toBeGreaterThan(0)
    expect(own.spans).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'invoke_agent', status: 'success', durationMs: expect.any(Number) })]))
    expect(first.some(event => event.t === 'span')).toBe(true)
    const other = 'sk-edge-other-fixture'
    const app = createEdgeChatApp()
    const traces = await app.fetch(new Request(`https://edge.test/api/traces/${String(runId)}`, { headers: { 'x-openai-key': other } }))
    await expect(traces.json()).resolves.toEqual({ spans: [] })
    expect(await dropSession('edge-owner', other)).toBe(false)
    expect(await findSession('edge-owner', KEY)).toBeDefined()
    await wire(await chat('edge-owner', { message: 'Other public input.' }, other))
    expect(JSON.stringify(calls[1]?.body)).not.toContain('PRIVATE/owner%canary')
    expect(activeSessions()).toBe(2)
  })
})

// The key digest is an asynchronous host boundary. Release both real digests
// together so the test covers concurrent construction instead of OS scheduling.
function synchronizeDigests(): void {
  const original = crypto.subtle.digest.bind(crypto.subtle)
  let arrived = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const digest = await original(...args)
    if (++arrived >= 2) release()
    await gate
    return digest
  })
}
