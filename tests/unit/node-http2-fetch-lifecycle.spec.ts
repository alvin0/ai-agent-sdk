import { afterEach, expect, it, vi } from 'vitest'
import { constants } from 'node:http2'
import { cleanupHttp2Fixtures, client, h2Server, http2Entry, runWithGc } from './fixtures/node-http2.ts'

afterEach(cleanupHttp2Fixtures)

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
    import { createNodeHttp2Fetch } from ${JSON.stringify(http2Entry)}
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
    import { createNodeHttp2Fetch } from ${JSON.stringify(http2Entry)}
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
    import { createNodeHttp2Fetch } from ${JSON.stringify(http2Entry)}
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
    import { createNodeHttp2Fetch } from ${JSON.stringify(http2Entry)}
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
