import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  constants, createSecureServer, type Http2SecureServer, type ServerHttp2Stream, type Settings,
} from 'node:http2'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { createNodeHttp2Fetch, type NodeHttp2Fetch } from '../../packages/auth-node/src/http2.ts'

const key = readFileSync(new URL('../fixtures/tls/localhost-key.pem', import.meta.url))
const cert = readFileSync(new URL('../fixtures/tls/localhost-cert.pem', import.meta.url))

type Handler = (stream: ServerHttp2Stream, headers: Record<string, unknown>, body: string) => void

interface H2Fixture {
  readonly origin: string
  readonly sessions: () => number
  /** Most streams any one session carried at the same time. */
  readonly peakStreamsPerSession: () => number
  readonly closedSessions: () => number
  close(): Promise<void>
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function h2Server(handler: Handler, settings: Settings = {}): Promise<H2Fixture> {
  let sessions = 0, closed = 0, peak = 0
  const open = new Map<object, number>()
  const server: Http2SecureServer = createSecureServer({ key, cert, settings })
  server.on('session', session => { sessions++; session.on('close', () => { closed++ }) })
  server.on('stream', (stream, headers) => {
    const owner = stream.session as object
    open.set(owner, (open.get(owner) ?? 0) + 1)
    peak = Math.max(peak, open.get(owner)!)
    stream.on('close', () => { open.set(owner, open.get(owner)! - 1) })
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => handler(stream as ServerHttp2Stream, headers, Buffer.concat(chunks).toString()))
    stream.on('error', () => undefined)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const fixture: H2Fixture = {
    origin: `https://localhost:${(server.address() as AddressInfo).port}`,
    sessions: () => sessions,
    peakStreamsPerSession: () => peak,
    closedSessions: () => closed,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
  cleanups.push(() => fixture.close())
  return fixture
}

function client(options: Parameters<typeof createNodeHttp2Fetch>[0] = {}): NodeHttp2Fetch {
  const fetchImpl = createNodeHttp2Fetch({ tls: { ca: cert }, ...options })
  cleanups.push(() => fetchImpl.close())
  return fetchImpl
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('createNodeHttp2Fetch', () => {
  it('multiplexes concurrent POSTs as parallel streams on one session', async () => {
    const count = 8
    const all = deferred()
    let arrived = 0
    const server = await h2Server((stream, _headers, body) => {
      // No response until every request is in flight: a serializing transport would deadlock here.
      if (++arrived === count) all.resolve()
      void all.promise.then(() => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ echo: JSON.parse(body) }))
      })
    })
    const fetchImpl = client()
    const responses = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const response = await fetchImpl(`${server.origin}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index }),
      })
      return await response.json() as { echo: { index: number } }
    }))
    expect(responses.map(value => value.echo.index)).toEqual([...Array(count).keys()])
    expect(server.sessions()).toBe(1)
  }, 10_000)

  it('opens another session only when the server stream limit is reached', async () => {
    const all = deferred()
    let arrived = 0
    const server = await h2Server((stream, headers) => {
      if (headers[':path'] === '/warm') { stream.respond({ ':status': 200 }); stream.end('warm'); return }
      if (++arrived === 5) all.resolve()
      void all.promise.then(() => { stream.respond({ ':status': 200 }); stream.end('ok') })
    }, { maxConcurrentStreams: 2 })
    const fetchImpl = client()
    // Learn the server's SETTINGS on a first session before the burst.
    await (await fetchImpl(`${server.origin}/warm`, { method: 'POST', body: 'x' })).text()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Bodiless requests pick their sessions in the same turn, before any new session's SETTINGS arrive.
    const bodies = await Promise.all(Array.from({ length: 5 }, async () =>
      await (await fetchImpl(`${server.origin}/burst`)).text()))
    expect(bodies).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(server.peakStreamsPerSession()).toBe(2)
    expect(server.sessions()).toBe(3)
  }, 10_000)

  it('streams the body incrementally and cancels the stream on abort', async () => {
    const reset = deferred()
    let resetCode = -1
    const server = await h2Server((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' })
      stream.write('data: first\n\n')
      stream.on('close', () => { resetCode = stream.rstCode; reset.resolve() })
    })
    const controller = new AbortController()
    const response = await client()(`${server.origin}/stream`, { method: 'POST', body: '{}', signal: controller.signal })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
    const reason = new Error('caller stopped')
    controller.abort(reason)
    await expect(reader.read()).rejects.toBe(reason)
    await reset.promise
    // CANCEL ("no longer needed"), not the INTERNAL_ERROR Node sends for destroy(error).
    expect(resetCode).toBe(constants.NGHTTP2_CANCEL)
  }, 10_000)

  it('resets with CANCEL when the body is cancelled, and never resets a finished exchange', async () => {
    // Keyed by path: the two streams may close in either order.
    const codes: Record<string, number> = {}
    const closed = { count: 0, all: deferred() }
    const server = await h2Server((stream, headers) => {
      const path = String(headers[':path'])
      stream.on('close', () => { codes[path] = stream.rstCode; if (++closed.count === 2) closed.all.resolve() })
      stream.respond({ ':status': 200 })
      if (headers[':path'] === '/done') stream.end('complete')
      else stream.write('partial')
    })
    const fetchImpl = client()
    const open = await fetchImpl(`${server.origin}/open`)
    const reader = open.body!.getReader()
    await reader.read()
    await reader.cancel(new Error('not needed'))
    // A consumer that aborts its signal after reading everything (as the Copilot stream reader does).
    const controller = new AbortController()
    const done = await fetchImpl(`${server.origin}/done`, { signal: controller.signal })
    expect(await done.text()).toBe('complete')
    controller.abort(new Error('consumer stopped'))
    await closed.all.promise
    expect(codes).toEqual({ '/open': constants.NGHTTP2_CANCEL, '/done': constants.NGHTTP2_NO_ERROR })
  }, 10_000)

  it('rejects with the abort reason before response headers arrive', async () => {
    const server = await h2Server(() => { /* never responds */ })
    const controller = new AbortController()
    const pending = client()(`${server.origin}/hang`, { method: 'POST', body: '{}', signal: controller.signal })
    const reason = new Error('timeout')
    setTimeout(() => controller.abort(reason), 50)
    await expect(pending).rejects.toBe(reason)
  }, 10_000)

  it('decodes gzip like fetch and keeps response metadata', async () => {
    const server = await h2Server((stream) => {
      stream.respond({ ':status': 201, 'content-encoding': 'gzip', 'x-request-id': 'abc' })
      stream.end(gzipSync('compressed body'))
    })
    const response = await client()(`${server.origin}/gz`)
    expect(response.status).toBe(201)
    expect(response.headers.get('x-request-id')).toBe('abc')
    expect(response.url).toBe(`${server.origin}/gz`)
    expect(await response.text()).toBe('compressed body')
  })

  it('sends request headers without connection-specific fields', async () => {
    let seen: Record<string, unknown> = {}
    const server = await h2Server((stream, headers) => { seen = headers; stream.respond({ ':status': 204 }); stream.end() })
    const response = await client()(`${server.origin}/h?q=1`, {
      method: 'POST', headers: { authorization: 'Bearer t', connection: 'keep-alive' }, body: 'abc',
    })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(seen).toMatchObject({ ':method': 'POST', ':path': '/h?q=1', authorization: 'Bearer t', 'content-length': '3' })
    expect(seen.connection).toBeUndefined()
    // Like Node's fetch: a default user-agent (GitHub's API rejects requests without one), never overriding the caller's.
    expect(seen['user-agent']).toBe('node')
    await client()(`${server.origin}/ua`, { headers: { 'user-agent': 'sdk/1' } })
    expect(seen['user-agent']).toBe('sdk/1')
  })

  it('follows redirects like fetch and honors manual mode', async () => {
    const seen: string[] = []
    const server = await h2Server((stream, headers, body) => {
      seen.push(`${String(headers[':method'])} ${String(headers[':path'])} ${body}`)
      if (headers[':path'] === '/see-other') { stream.respond({ ':status': 303, location: '/final' }); stream.end(); return }
      if (headers[':path'] === '/temporary') { stream.respond({ ':status': 307, location: '/final' }); stream.end(); return }
      stream.respond({ ':status': 200 }); stream.end('done')
    })
    const fetchImpl = client()
    const followed = await fetchImpl(`${server.origin}/see-other`, { method: 'POST', body: 'payload' })
    expect([followed.status, followed.redirected, await followed.text()]).toEqual([200, true, 'done'])
    await (await fetchImpl(`${server.origin}/temporary`, { method: 'POST', body: 'again' })).text()
    const manual = await fetchImpl(`${server.origin}/see-other`, { method: 'POST', body: 'm', redirect: 'manual' })
    expect([manual.status, manual.headers.get('location')]).toEqual([303, '/final'])
    expect(seen).toEqual([
      'POST /see-other payload', 'GET /final ', 'POST /temporary again', 'POST /final again', 'POST /see-other m',
    ])
  })

  it('falls back for origins without h2 and for plain http', async () => {
    const h1: HttpsServer = createHttpsServer({ key, cert }, (_request, response) => { response.end('h1') })
    await new Promise<void>(resolve => h1.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => { h1.close(() => resolve()) }))
    const origin = `https://localhost:${(h1.address() as AddressInfo).port}`
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ fallback })
    expect(await (await fetchImpl(`${origin}/a`, { method: 'POST', body: 'x' })).text()).toBe('via fallback')
    // The origin is remembered: no second h2 attempt within the fallback window.
    expect(await (await fetchImpl(`${origin}/b`)).text()).toBe('via fallback')
    expect(await (await fetchImpl('http://localhost:1/plain')).text()).toBe('via fallback')
    expect(fallback).toHaveBeenCalledTimes(3)
    const [url, init] = fallback.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe(`${origin}/a`)
    expect(init.method).toBe('POST')
  })

  it('closes idle sessions without holding the process open', async () => {
    const server = await h2Server((stream) => { stream.respond({ ':status': 200 }); stream.end('ok') })
    const fetchImpl = client({ idleTimeoutMs: 50 })
    await (await fetchImpl(`${server.origin}/idle`)).text()
    expect(server.sessions()).toBe(1)
    await vi.waitFor(() => expect(server.closedSessions()).toBe(1), { timeout: 2_000 })
    await (await fetchImpl(`${server.origin}/again`)).text()
    expect(server.sessions()).toBe(2)
  })

  it('reads a complete early response although the server then stops the upload', async () => {
    const server = createSecureServer({ key, cert })
    server.on('stream', (incoming) => {
      const stream = incoming as ServerHttp2Stream
      stream.on('error', () => undefined)
      stream.respond({ ':status': 413, 'content-type': 'application/json' })
      // RFC 9113 §8.1: answer, then stop the upload still in flight with NO_ERROR.
      stream.end(JSON.stringify({ error: 'too large' }), () => { stream.close(constants.NGHTTP2_NO_ERROR) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
    const origin = `https://localhost:${(server.address() as AddressInfo).port}`
    const response = await client()(`${origin}/upload`, { method: 'POST', body: new Uint8Array(5 * 1024 * 1024) })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too large' })
  }, 10_000)

  /** Accepts TCP and never answers the TLS handshake. */
  async function stalledOrigin(): Promise<{ origin: string; connections: () => number }> {
    const sockets: Socket[] = []
    const server = createTcpServer((socket) => { sockets.push(socket); socket.on('error', () => undefined) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }))
    return { origin: `https://localhost:${(server.address() as AddressInfo).port}`, connections: () => sockets.length }
  }

  it('rejects at once when the caller aborts while the session is still connecting', async () => {
    const { origin } = await stalledOrigin()
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ connectTimeoutMs: 5_000, fallback })
    const started = performance.now()
    await expect(fetchImpl(`${origin}/slow`, { signal: AbortSignal.timeout(100) }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(fallback).not.toHaveBeenCalled()
  }, 10_000)

  it('remembers a failed connect, so later requests go straight to the fallback', async () => {
    const stalled = await stalledOrigin()
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ connectTimeoutMs: 100, fallback })
    expect(await (await fetchImpl(`${stalled.origin}/a`)).text()).toBe('via fallback')
    const started = performance.now()
    expect(await (await fetchImpl(`${stalled.origin}/b`)).text()).toBe('via fallback')
    expect(performance.now() - started).toBeLessThan(50)
    expect(stalled.connections()).toBe(1)
    expect(fallback).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('rejects every request after close() instead of using the fallback', async () => {
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ fallback })
    await fetchImpl.close()
    await expect(fetchImpl('https://localhost:1/late')).rejects.toThrow(TypeError)
    await expect(fetchImpl('http://localhost:1/late')).rejects.toMatchObject({ cause: { name: 'Http2ClosedError' } })
    expect(fallback).not.toHaveBeenCalled()
  })
})
