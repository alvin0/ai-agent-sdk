import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpanId, createTraceId } from '@alvin0/ai-agent-sdk-core'
import {
  capturingFetch, providerErrorDetail, resetProviderError, type ProviderErrorBox,
} from '../../samples/edge-runtime-chat-agents/web/src/server/provider-error'
import { TraceStore } from '../../samples/edge-runtime-chat-agents/web/src/server/traces'

afterEach(() => vi.unstubAllGlobals())

describe('Edge sample provider error observation', () => {
  it('withholds incomplete plain text diagnostics when the byte cap cuts an opaque key', async () => {
    const key = 'opaque-private-credential-fixture'
    const text = `${'x'.repeat(4090)}${key}`
    vi.stubGlobal('fetch', async () => new Response(text, { status: 401 }))
    const box: ProviderErrorBox = { message: undefined }
    expect(await (await capturingFetch(box, key)('https://example.test/')).text()).toBe(text)
    expect(box.message).toBeUndefined()
  })

  it('withholds canceled and errored body prefixes containing a partial opaque key', async () => {
    const key = 'opaque-private-credential-fixture'
    for (const terminate of ['cancel', 'error']) {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
        start(target) { controller = target; target.enqueue(new TextEncoder().encode(`Invalid ${key.slice(0, 15)}`)) },
      }), { status: 401 }))
      const box: ProviderErrorBox = { message: undefined }
      const response = await capturingFetch(box, key)('https://example.test/')
      const reader = response.body!.getReader()
      await reader.read()
      if (terminate === 'cancel') await reader.cancel()
      else { controller.error(new Error('fixture interrupted')); await reader.read().catch(() => undefined) }
      expect(box.message).toBeUndefined()
    }
  })

  it('redacts upstream clipped trace credentials and credentials in property names', () => {
    const key = 'opaque-private-credential-fixture'
    const prefix = key.slice(0, 15)
    const store = new TraceStore(key)
    const trace = store.start('fixture', 'public prompt')
    const span = trace.observe({
      type: 'span-start', kind: 'chat', name: 'chat fixture', at: new Date().toISOString(),
      trace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null },
      input: { system: `${'x'.repeat(600 - prefix.length)}${prefix}…`, [key]: 'private property' },
    })
    expect(JSON.stringify(span)).not.toContain(prefix)
    expect(JSON.stringify(store.read('fixture'))).not.toContain(prefix)
    expect(span?.input).toMatchObject({ '[REDACTED]': 'private property' })
    expect(JSON.stringify(span)).toContain('[REDACTED]…')
  })

  it('clears an earlier failure for an empty response, success, or rejected fetch', async () => {
    const box: ProviderErrorBox = { message: undefined }
    const observed = capturingFetch(box)
    for (const outcome of [new Response(null, { status: 503 }), new Response('ok'), new Error('network')]) {
      vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"earlier failure"}}', { status: 400 }))
      await (await observed('https://example.test/')).text()
      expect(box.message).toBe('earlier failure')
      vi.stubGlobal('fetch', async () => { if (outcome instanceof Error) throw outcome; return outcome })
      await observed('https://example.test/').catch(() => undefined)
      expect(box.message).toBeUndefined()
    }
  })

  it('keeps a late older response from overwriting the newest request', async () => {
    const box: ProviderErrorBox = { message: undefined }
    const responses = [new Response('older failure', { status: 400 }), new Response(null, { status: 503 })]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    const observed = capturingFetch(box)
    const older = await observed('https://example.test/')
    await observed('https://example.test/')
    await older.text()
    expect(box.message).toBeUndefined()
    expect(providerErrorDetail(box, { error: { status: 503 }, attempts: [] })).toBeUndefined()
  })

  it('invalidates pending observations when the next prompt resets the box', async () => {
    const box: ProviderErrorBox = { message: undefined }
    vi.stubGlobal('fetch', async () => new Response('previous prompt', { status: 400 }))
    const previous = await capturingFetch(box)('https://example.test/')
    resetProviderError(box)
    await previous.text()
    expect(box.message).toBeUndefined()
  })

  it('matches concurrent errors by request id and suppresses unidentified ambiguity', async () => {
    const box: ProviderErrorBox = { message: undefined }
    const responses = [new Response('older failure', { status: 400 }), new Response('current failure', {
      status: 503, headers: { 'x-request-id': 'current' },
    })]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    const observed = capturingFetch(box)
    const older = await observed('https://example.test/')
    await (await observed('https://example.test/')).text()
    await older.text()
    expect(providerErrorDetail(box, { error: { status: 503 }, attempts: [{ providerRequestId: 'current' }] }))
      .toBe('current failure')
    expect(providerErrorDetail(box, { error: { status: 503 }, attempts: [{ providerRequestId: 'other' }] }))
      .toBeUndefined()
    expect(providerErrorDetail(box, { error: { status: 400 }, attempts: [{ providerRequestId: 'current' }] }))
      .toBeUndefined()
    delete box.requestId
    expect(providerErrorDetail(box, { error: { status: 503 }, attempts: [] })).toBeUndefined()
  })

  it('keeps the latest sequential retry detail for gateways without request ids', async () => {
    const box: ProviderErrorBox = { message: undefined }
    const responses = [
      new Response('first failure', { status: 400 }), new Response('terminal failure', { status: 503 }),
    ]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    const observed = capturingFetch(box)
    await (await observed('https://example.test/')).text()
    await (await observed('https://example.test/')).text()
    expect(providerErrorDetail(box, { error: { status: 503 }, attempts: [] })).toBe('terminal failure')
  })

  it('redacts the configured key, bearer credentials and provider key echoes before truncation', async () => {
    const key = 'gateway-secret-fixture'
    const message = `Invalid ${key} Bearer token-fixture and sk-provider-fixture`
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message } }), { status: 401 }))
    const box: ProviderErrorBox = { message: undefined }
    await (await capturingFetch(box, key)('https://example.test/')).text()
    expect(box.message).toBe('Invalid [REDACTED] Bearer [REDACTED] and [REDACTED]')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 'private-fixture' }), { status: 401 }))
    await (await capturingFetch(box, key)('https://example.test/')).text()
    expect(box.message).toBeUndefined()
    vi.stubGlobal('fetch', async () => new Response('{"token":"private-fixture",', { status: 401 }))
    await (await capturingFetch(box, key)('https://example.test/')).text()
    expect(box.message).toBeUndefined()
    vi.stubGlobal('fetch', async () => new Response(message, { status: 401 }))
    await (await capturingFetch(box, key)('https://example.test/')).text()
    expect(box.message).toBe('Invalid [REDACTED] Bearer [REDACTED] and [REDACTED]')
  })

  it('reads with the SDK consumer and leaves the full response unchanged', async () => {
    let pulls = 0
    const chunk = new TextEncoder().encode('finite error text '.repeat(64))
    const original = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (pulls === 16) controller.close(); else { pulls++; controller.enqueue(chunk) } },
    }, { highWaterMark: 0 }), { status: 400, statusText: 'Bad Request', headers: { 'x-fixture': 'same' } })
    Object.defineProperty(original, 'url', { value: 'https://example.test/original' })
    vi.stubGlobal('fetch', async () => original)
    const box = { message: undefined as string | undefined }
    const observed = await capturingFetch(box)('https://example.test/')
    expect(pulls).toBe(0)
    expect(box.message).toBeUndefined()
    expect(observed.status).toBe(original.status)
    expect(observed.statusText).toBe(original.statusText)
    expect(observed.headers.get('x-fixture')).toBe('same')
    expect(observed.url).toBe(original.url)
    expect(await observed.text()).toBe(new TextDecoder().decode(chunk).repeat(16))
    expect(pulls).toBe(16)
    expect(box.message).toBeUndefined()
  })

  it('cancels the upstream body when the SDK stops after its first chunk', async () => {
    let pulls = 0, cancellations = 0
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('finite fixture')) },
      cancel() { cancellations++ },
    }, { highWaterMark: 0 }), { status: 400 }))
    const response = await capturingFetch({ message: undefined })('https://example.test/')
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect({ pulls, cancellations }).toEqual({ pulls: 1, cancellations: 1 })
  })

  it('extracts a small JSON error and returns successful responses directly', async () => {
    const wire = JSON.stringify({ error: { message: 'provider detail' } })
    vi.stubGlobal('fetch', async () => new Response(wire, { status: 400 }))
    const box = { message: undefined as string | undefined }
    const response = await capturingFetch(box)('https://example.test/')
    expect(await response.text()).toBe(wire)
    expect(box.message).toBe('provider detail')
    const success = new Response('successful fixture')
    vi.stubGlobal('fetch', async () => success)
    expect(await capturingFetch(box)('https://example.test/')).toBe(success)
  })
})
