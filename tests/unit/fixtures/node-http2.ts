import { readFileSync } from 'node:fs'
import { createSecureServer, type Http2SecureServer, type ServerHttp2Stream, type Settings } from 'node:http2'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { createNodeHttp2Fetch, type NodeHttp2Fetch } from '../../../packages/auth-node/src/http2.ts'

export const http2Entry = new URL('../../../packages/auth-node/src/http2.ts', import.meta.url).href

export const key = readFileSync(new URL('../../fixtures/tls/localhost-key.pem', import.meta.url))
export const cert = readFileSync(new URL('../../fixtures/tls/localhost-cert.pem', import.meta.url))

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
export async function runWithGc(script: string, url: string): Promise<{ output: string; code: number | null }> {
  const { spawn } = await import('node:child_process')
  const args = ['--expose-gc', '--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script]
  const child = spawn(process.execPath, args, {
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
export async function cleanupHttp2Fixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

export function closeServerAfterTest(server: { close(callback: () => void): unknown }): void {
  cleanups.push(() => new Promise<void>(resolve => { server.close(resolve) }))
}

export async function h2Server(handler: Handler, settings: Settings = {}): Promise<H2Fixture> {
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

export function client(options: Parameters<typeof createNodeHttp2Fetch>[0] = {}): NodeHttp2Fetch {
  const fetchImpl = createNodeHttp2Fetch({ tls: { ca: cert }, ...options })
  cleanups.push(() => fetchImpl.close())
  return fetchImpl
}

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
/** Accepts TCP and never answers the TLS handshake. */
export async function stalledOrigin(): Promise<{ origin: string; connections: () => number }> {
  const sockets: Socket[] = []
  const server = createTcpServer((socket) => { sockets.push(socket); socket.on('error', () => undefined) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  }))
  return { origin: `https://localhost:${(server.address() as AddressInfo).port}`, connections: () => sockets.length }
}
