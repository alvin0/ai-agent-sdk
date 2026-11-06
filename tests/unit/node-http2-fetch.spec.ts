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

/** Run an ES module script in a child Node process with `gc()` exposed; resolves when it exits. */
async function runWithGc(script: string, url: string): Promise<{ output: string; code: number | null }> {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['--expose-gc', '--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, H2_CA: cert.toString(), H2_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(null) }, 8_000)
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  return { output, code }
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

  it('remembers a transient connect failure only briefly, unlike an origin without h2', async () => {
    const stalled = await stalledOrigin()
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ connectTimeoutMs: 100, fallback })
    const realNow = Date.now
    let skew = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
    try {
      expect(await (await fetchImpl(`${stalled.origin}/a`)).text()).toBe('via fallback')
      expect(stalled.connections()).toBe(1)
      // Well inside the default 5 min no-h2 window, but past the 5 s transient one.
      skew = 6_000
      expect(await (await fetchImpl(`${stalled.origin}/b`)).text()).toBe('via fallback')
      await vi.waitFor(() => expect(stalled.connections()).toBe(2))
    } finally {
      now.mockRestore()
    }
  }, 10_000)

  it('lets the process exit with an unread body and cancels a body that was dropped', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream, headers) => {
      if (headers[':path'] === '/cancelled') {
        stream.respond({ ':status': 200 })
        stream.end(String(cancelled))
        return
      }
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 500, 'content-type': 'text/plain' })
      // Far more than the body's high-water mark; the stream never ends on its own.
      stream.write(Buffer.alloc(1024 * 1024, 120))
    })
    const script = `
      import { createNodeHttp2Fetch } from ${JSON.stringify(new URL('../../packages/auth-node/src/http2.ts', import.meta.url).href)}
      const fetchImpl = createNodeHttp2Fetch({ tls: { ca: process.env.H2_CA } })
      let response = await fetchImpl(process.env.H2_URL)
      if (response.ok) throw new Error('expected an error status')
      // Dropped without reading or cancelling the body, as an \`if (!res.ok) throw\` does.
      response = undefined
      // The Response is collected first; its unread, unreferenced body on the next collection.
      for (let round = 0; round < 3; round++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        globalThis.gc()
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      // Asked while this process is still alive, so the reset came from collection, not exit.
      console.log('cancelled=' + await (await fetchImpl(new URL('/cancelled', process.env.H2_URL))).text())
      console.log('exiting')
    `
    const { output, code } = await runWithGc(script, `${fixture.origin}/large`)
    expect(output).toContain('cancelled=1')
    expect(output).toContain('exiting')
    expect(code).toBe(0)
    expect(cancelled).toBe(1)
  }, 15_000)

  it('cancels an unread body whose stream stays open with less than its high-water mark', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream, headers) => {
      if (headers[':path'] === '/cancelled') {
        stream.respond({ ':status': 200 })
        stream.end(String(cancelled))
        return
      }
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 200, 'content-type': 'text/plain' })
      // Far below the body's high-water mark, so it never pauses; the stream never ends.
      stream.write('partial')
    })
    const script = `
      import { createNodeHttp2Fetch } from ${JSON.stringify(new URL('../../packages/auth-node/src/http2.ts', import.meta.url).href)}
      const fetchImpl = createNodeHttp2Fetch({ tls: { ca: process.env.H2_CA } })
      let response = await fetchImpl(process.env.H2_URL)
      await new Promise(resolve => setTimeout(resolve, 50))
      response = undefined
      // The Response is collected first; its unread, unreferenced body on the next collection.
      for (let round = 0; round < 3; round++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        globalThis.gc()
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      console.log('cancelled=' + await (await fetchImpl(new URL('/cancelled', process.env.H2_URL))).text())
      console.log('exiting')
    `
    const { output, code } = await runWithGc(script, `${fixture.origin}/idle`)
    expect(output).toContain('cancelled=1')
    expect(output).toContain('exiting')
    // With its stream cancelled the slot is released, so nothing holds the process open.
    expect(code).toBe(0)
  }, 15_000)

  it('keeps a body the caller holds readable after its Response was collected', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream) => {
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 200, 'content-type': 'text/plain' })
      stream.write('first;')
      setTimeout(() => { if (!stream.destroyed) stream.end('second;') }, 400)
    })
    const script = `
      import { createNodeHttp2Fetch } from ${JSON.stringify(new URL('../../packages/auth-node/src/http2.ts', import.meta.url).href)}
      const fetchImpl = createNodeHttp2Fetch({ tls: { ca: process.env.H2_CA } })
      // Only the body is kept; its Response is dropped at once.
      const body = (await fetchImpl(process.env.H2_URL)).body
      for (let round = 0; round < 3; round++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        globalThis.gc()
      }
      console.log('text=' + await new Response(body).text())
    `
    const { output, code } = await runWithGc(script, `${fixture.origin}/kept`)
    expect(output).toContain('text=first;second;')
    expect(code).toBe(0)
    expect(cancelled).toBe(0)
  }, 15_000)

  it('keeps the body timeout working after the reader paused the body, and not while it is paused', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream) => {
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' })
      // More than the body queue holds, so it pauses until the reader catches up; then the server stalls.
      stream.write(Buffer.alloc(1024 * 1024))
    })
    const fetchImpl = client({ bodyTimeoutMs: 150 })
    const response = await fetchImpl(`${fixture.origin}/paused-then-stalled`)
    // Waiting on a reader that does not read is not the server's silence.
    await new Promise(resolve => setTimeout(resolve, 400))
    const started = Date.now()
    await expect(response.arrayBuffer()).rejects.toThrow(/no data for 150 ms/)
    expect(Date.now() - started).toBeLessThan(2_000)
    await vi.waitFor(() => expect(cancelled).toBe(1))
    await expect(fetchImpl.close()).resolves.toBeUndefined()
  }, 10_000)

  it('fails a body whose server sends nothing for bodyTimeoutMs and resets its stream', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream) => {
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 200, 'content-type': 'text/plain' })
      stream.write('partial')
    })
    const fetchImpl = client({ bodyTimeoutMs: 150 })
    const response = await fetchImpl(`${fixture.origin}/stalled`)
    await expect(response.text()).rejects.toThrow(/no data for 150 ms/)
    await vi.waitFor(() => expect(cancelled).toBe(1))
    await expect(fetchImpl.close()).resolves.toBeUndefined()
  }, 10_000)

  it('keeps a body that is being read alive across garbage collections between chunks', async () => {
    let cancelled = 0
    const fixture = await h2Server((stream) => {
      stream.on('close', () => { if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++ })
      stream.respond({ ':status': 200, 'content-type': 'text/plain' })
      let sent = 0
      const timer = setInterval(() => {
        if (stream.destroyed) { clearInterval(timer); return }
        stream.write(`chunk${sent};`)
        if (++sent === 6) { clearInterval(timer); stream.end() }
      }, 40)
    })
    // Nothing but the pending read keeps the caller's promise chain reachable, and
    // a full collection runs between every chunk.
    const script = `
      import { createNodeHttp2Fetch } from ${JSON.stringify(new URL('../../packages/auth-node/src/http2.ts', import.meta.url).href)}
      const fetchImpl = createNodeHttp2Fetch({ tls: { ca: process.env.H2_CA } })
      setInterval(() => globalThis.gc(), 5).unref()
      const read = async () => await (await fetchImpl(process.env.H2_URL)).text()
      void read().then(text => console.log('text=' + text), error => console.log('error=' + error?.message))
    `
    const { output, code } = await runWithGc(script, `${fixture.origin}/slow`)
    expect(output).toContain('text=chunk0;chunk1;chunk2;chunk3;chunk4;chunk5;')
    expect(code).toBe(0)
    expect(cancelled).toBe(0)
  }, 15_000)

  it('falls back to the replaced fetch, not itself, when installed as the global fetch', async () => {
    const fetchImpl = client()
    vi.stubGlobal('fetch', fetchImpl)
    try {
      // Plain HTTP goes to the fallback; calling the global would loop back into this transport.
      await expect(fetchImpl('http://127.0.0.1:1/unreachable')).rejects.toThrow(TypeError)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects every request after close() instead of using the fallback', async () => {
    const fallback = vi.fn(async () => new Response('via fallback'))
    const fetchImpl = client({ fallback })
    await fetchImpl.close()
    await expect(fetchImpl('https://localhost:1/late')).rejects.toThrow(TypeError)
    await expect(fetchImpl('http://localhost:1/late')).rejects.toMatchObject({ cause: { name: 'Http2ClosedError' } })
    expect(fallback).not.toHaveBeenCalled()
  })
})
