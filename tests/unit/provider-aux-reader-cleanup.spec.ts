import { describe, expect, it, vi } from 'vitest'
import { oauthFetch, readResponseText } from '../../packages/provider-codex/src/oauth-http.ts'
import { discoverCodexModels, readCatalogJson } from '../../packages/provider-codex/src/catalog.ts'
import { copilotFetch, issuerOf, readCopilotResponseText } from '../../packages/provider-copilot/src/common/http.ts'
import { copilotProviderFetch, readErrorBody } from '../../packages/provider-copilot/src/adapter-fetch.ts'

const readers = [
  { name: 'Codex OAuth', read: (response: Response, signal: AbortSignal) => readResponseText(response, { signal }) },
  { name: 'Codex catalog', read: (response: Response, signal: AbortSignal) =>
    readCatalogJson(response, { maxBytes: 1024, maxChunks: 10 }, signal) },
  { name: 'Copilot JSON', read: (response: Response, signal: AbortSignal) =>
    readCopilotResponseText(response, { signal }) },
]

describe.each(readers)('$name response ownership', ({ read }) => {
  it('cancels its unfinished response body and preserves caller cancellation', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    const reading = read(new Response(body), controller.signal)
    const rejected = expect(reading).rejects.toBe(reason)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(reason)
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it('leaves a fully read response uncancelled', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close() }, cancel,
    })
    await read(new Response(body), new AbortController().signal)
    expect(cancel).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })
})

const requests = [
  { name: 'Codex OAuth', run: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
    oauthFetch({ fetch, signal }, 'https://auth.openai.com/oauth/token', { method: 'POST' }) },
  { name: 'Codex catalog', run: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
    discoverCodexModels({ baseUrl: 'https://chatgpt.com/backend-api/codex', headers: {}, signal }, 'fixture',
      { maxBytes: 1024, maxChunks: 10, maxModels: 10, timeoutMs: 30_000 }, fetch) },
  { name: 'Copilot JSON', run: (fetch: typeof globalThis.fetch, signal: AbortSignal) => {
    const pinned = issuerOf('githubApiBaseUrl', undefined, 'https://api.github.com')
    return copilotFetch({ pinned, url: `${pinned.href}/fixture`, operation: 'token exchange',
      init: { method: 'GET' } }, { fetch, signal })
  } },
]

describe.each(requests)('$name fetch ownership', ({ run }) => {
  it('settles cancellation and disposes a later response', async () => {
    let deliver!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve }))
    const cancel = vi.fn()
    const controller = new AbortController()
    const reason = new Error('caller cancelled before response')
    const work = run(fetch, controller.signal)
    const rejected = expect(work).rejects.toBe(reason)
    controller.abort(reason)
    try { await rejected } finally {
      deliver(new Response(new ReadableStream<Uint8Array>({ cancel })))
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch when the operation was already cancelled', async () => {
    const fetch = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(run(fetch, controller.signal)).rejects.toBe(controller.signal.reason)
    expect(fetch).not.toHaveBeenCalled()
  })
})

it('disposes a refused Codex catalog response while preserving the empty catalog result', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 })
  const fetch = vi.fn(async () => response)
  await expect(discoverCodexModels({ baseUrl: 'https://chatgpt.com/backend-api/codex', headers: {} }, 'fixture',
    { maxBytes: 1024, maxChunks: 10, maxModels: 10, timeoutMs: 30_000 }, fetch)).resolves.toEqual([])
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('cancels the Copilot generation error-body reader with its request', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const response = new Response(body, { status: 503 })
  const fetch = copilotProviderFetch({ fetch: vi.fn(async () => response),
    authStore: { location: 'fixture', read: async () => undefined, write: async () => undefined } },
    { remember: () => undefined, redact: text => text })
  const controller = new AbortController()
  const work = fetch('https://api.githubcopilot.com/responses', { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await expect(work).resolves.toBe(response)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(body.locked).toBe(false)
})

it('returns a truncated Copilot error while asynchronous body cleanup completes separately', async () => {
  let release!: () => void
  const closing = new Promise<void>(resolve => { release = resolve })
  const cancel = vi.fn(() => closing)
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('12345678')) }, cancel,
  })
  let settled = false
  const work = readErrorBody(new Response(body), 4).then(text => { settled = true; return text })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    await expect(work).resolves.toBe('1234\n[error body truncated at 4 bytes]')
    expect(body.locked).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally { release(); await work }
})
