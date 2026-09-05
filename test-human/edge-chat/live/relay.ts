import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { attributionHeaders } from '@ai-agent-sdk/core'
import { CODEX_BASE_URL } from '@ai-agent-sdk/provider-codex'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept', 'authorization', 'chatgpt-account-id', 'content-type', 'originator',
  'session-id', 'x-openai-fedramp',
])
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'cache-control', 'content-type', 'openai-processing-ms', 'x-request-id',
])

export interface CodexRelaySnapshot {
  readonly requests: number
  readonly successfulResponses: number
  readonly upstreamFailures: number
  readonly downstreamInterruptions: number
  readonly requestBytes: number
  readonly responseBytes: number
  readonly statuses: Readonly<Record<string, number>>
}

export interface CodexRelay {
  readonly origin: string
  snapshot(): CodexRelaySnapshot
  close(): Promise<void>
}

/**
 * Test-only loopback transport for upstreams that reject workerd's network
 * fingerprint. The target origin/path are fixed and credentials are never logged.
 */
export async function startCodexRelay(secret: string): Promise<CodexRelay> {
  if (secret.length < 32) throw new TypeError('relay secret is too short')
  const mutable = {
    requests: 0, successfulResponses: 0, upstreamFailures: 0,
    downstreamInterruptions: 0,
    requestBytes: 0, responseBytes: 0, statuses: new Map<number, number>(),
  }
  const server = createServer((request, response) => {
    void relay(request, response, secret, mutable)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Codex relay did not bind a TCP port')
  }
  let closing: Promise<void> | undefined
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    snapshot: () => Object.freeze({
      requests: mutable.requests,
      successfulResponses: mutable.successfulResponses,
      upstreamFailures: mutable.upstreamFailures,
      downstreamInterruptions: mutable.downstreamInterruptions,
      requestBytes: mutable.requestBytes,
      responseBytes: mutable.responseBytes,
      statuses: Object.freeze(Object.fromEntries(
        [...mutable.statuses].sort(([left], [right]) => left - right)
          .map(([status, count]) => [String(status), count]),
      )),
    }),
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
      return closing
    },
  })
}

async function relay(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  stats: {
    requests: number
    successfulResponses: number
    upstreamFailures: number
    downstreamInterruptions: number
    requestBytes: number
    responseBytes: number
    statuses: Map<number, number>
  },
): Promise<void> {
  stats.requests++
  if (request.method !== 'POST' || request.url !== '/responses'
    || request.headers['x-ai-agent-sdk-relay-secret'] !== secret) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not_found"}')
    return
  }
  const abort = new AbortController()
  let receivedUpstreamResponse = false
  response.once('close', () => { if (!response.writableEnded) abort.abort() })
  try {
    const body = await readRequest(request)
    stats.requestBytes += body.byteLength
    const headers = requestHeaders(request)
    const upstream = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: 'POST', headers, body, signal: abort.signal, redirect: 'manual',
    })
    receivedUpstreamResponse = true
    stats.statuses.set(upstream.status, (stats.statuses.get(upstream.status) ?? 0) + 1)
    if (upstream.ok) stats.successfulResponses++
    const responseHeaders = Object.fromEntries([...upstream.headers]
      .filter(([name]) => RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())))
    response.writeHead(upstream.status, responseHeaders)
    if (upstream.body === null) { response.end(); return }
    const reader = upstream.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stats.responseBytes += chunk.value.byteLength
      if (!response.write(Buffer.from(chunk.value))) await once(response, 'drain')
    }
    response.end()
  } catch (error) {
    if (receivedUpstreamResponse) stats.downstreamInterruptions++
    else stats.upstreamFailures++
    if (response.headersSent) response.destroy()
    else {
      response.writeHead(error instanceof RequestTooLargeError ? 413 : 502, {
        'content-type': 'application/json',
      })
      response.end('{"error":"relay_upstream_failed"}')
    }
  }
}

async function readRequest(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw new RequestTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || !REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(raw) ? raw.join(', ') : raw)
  }
  headers.set('user-agent', attributionHeaders()['user-agent']!)
  return headers
}

class RequestTooLargeError extends Error {}
