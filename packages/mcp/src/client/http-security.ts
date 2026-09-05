import { waitForSettlement } from '@ai-agent-sdk/core'
import type { McpHttpClientOptions } from './api-types.ts'
import type { McpFetch } from './public-types.ts'
import { positiveSafeInteger, raceAbort } from './runtime-helpers.ts'
import { MCP_CLIENT_DEFAULTS, MCP_HTTP_REDIRECT_STATUSES } from './config.ts'

export interface McpHttpSecurityOptions {
  readonly allowedOrigins?: readonly string[]
  readonly requireHttps: boolean
  readonly allowPrivateNetwork: boolean
  readonly allowRedirects: boolean
  readonly validateEndpoint?: (url: URL) => void
  readonly maxTransportBytes: number
  readonly timeoutMs: number
  readonly teardownTimeoutMs: number
}

export function snapshotHttpSecurityOptions(options: McpHttpClientOptions): McpHttpSecurityOptions {
  const allowedOrigins = options.allowedOrigins?.map((origin, index) => {
    let url: URL
    try { url = new URL(origin) } catch { throw new TypeError(`allowedOrigins[${index}] must be an absolute URL`) }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError(`allowedOrigins[${index}] must not contain credentials`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`allowedOrigins[${index}] must use http or https`)
    }
    return url.origin
  })
  return Object.freeze({
    ...(allowedOrigins === undefined ? {} : { allowedOrigins: Object.freeze([...new Set(allowedOrigins)]) }),
    requireHttps: options.requireHttps === true,
    allowPrivateNetwork: options.allowPrivateNetwork !== false,
    allowRedirects: options.allowRedirects !== false,
    ...(options.validateEndpoint === undefined ? {} : { validateEndpoint: options.validateEndpoint }),
    maxTransportBytes: positiveSafeInteger(
      options.maxTransportBytes ?? MCP_CLIENT_DEFAULTS.maxTransportBytes, 'maxTransportBytes',
    ),
    timeoutMs: positiveSafeInteger(
      options.operationTimeoutMs ?? MCP_CLIENT_DEFAULTS.operationTimeoutMs, 'operationTimeoutMs',
    ),
    teardownTimeoutMs: positiveSafeInteger(
      options.closeTimeoutMs ?? MCP_CLIENT_DEFAULTS.closeTimeoutMs, 'closeTimeoutMs',
    ),
  })
}

export function validateHttpEndpoint(value: string | URL, options: McpHttpSecurityOptions): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('MCP HTTP endpoint URL must not contain credentials')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use http or https')
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use https under the configured policy')
  }
  if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
    throw new TypeError(`MCP HTTP endpoint origin '${url.origin}' is not allowed`)
  }
  if (!options.allowPrivateNetwork && isPrivateHostname(url.hostname)) {
    throw new TypeError(`MCP HTTP endpoint host '${url.hostname}' is private or local`)
  }
  options.validateEndpoint?.(new URL(url))
  return url
}

export function createGuardedMcpFetch(baseFetch: McpFetch, options: McpHttpSecurityOptions): McpFetch {
  if (typeof baseFetch !== 'function') throw new TypeError('MCP HTTP transport requires fetch')
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let currentUrl = validateHttpEndpoint(input, options)
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout])
    let requestInit: RequestInit = { ...init, signal, redirect: 'manual' }
    let response: Response
    for (let hop = 0; ; hop++) {
      response = await raceAbort(Promise.resolve(baseFetch(currentUrl, requestInit)), signal)
      if (response.type === 'opaqueredirect') {
        await cancelResponse(response, options.teardownTimeoutMs)
        throw new Error('MCP HTTP transport rejected an opaque redirect')
      }
      if (!MCP_HTTP_REDIRECT_STATUSES.includes(response.status)) break
      if (!options.allowRedirects) {
        await cancelResponse(response, options.teardownTimeoutMs)
        throw new Error('MCP HTTP transport rejected a redirect')
      }
      if (hop >= MCP_CLIENT_DEFAULTS.maxRedirectHops) {
        await cancelResponse(response, options.teardownTimeoutMs)
        throw new Error(`MCP HTTP transport exceeded the ${MCP_CLIENT_DEFAULTS.maxRedirectHops}-redirect limit`)
      }
      const location = response.headers.get('location')
      if (location === null) {
        await cancelResponse(response, options.teardownTimeoutMs)
        throw new Error('MCP HTTP transport received a redirect without a location')
      }
      await cancelResponse(response, options.teardownTimeoutMs)
      const nextUrl = validateHttpEndpoint(new URL(location, currentUrl), options)
      const crossesOrigin = nextUrl.origin !== currentUrl.origin
      requestInit = redirectInit(requestInit, response.status, crossesOrigin)
      currentUrl = nextUrl
    }
    if (response.url.length > 0) {
      const responseUrl = validateHttpEndpoint(response.url, options)
      if (responseUrl.origin !== currentUrl.origin) {
        await cancelResponse(response, options.teardownTimeoutMs)
        throw new Error('MCP HTTP transport response escaped the validated origin')
      }
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > options.maxTransportBytes) {
      if (response.body !== null) {
        await waitForSettlement(response.body.cancel().catch(() => undefined), options.teardownTimeoutMs)
      }
      throw new Error(`MCP HTTP response exceeds the ${options.maxTransportBytes}-byte limit`)
    }
    if (response.body === null) return response
    let received = 0
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > options.maxTransportBytes) {
          controller.error(new Error(`MCP HTTP response exceeds the ${options.maxTransportBytes}-byte limit`))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as McpFetch
}

function redirectInit(previous: RequestInit, status: number, crossesOrigin: boolean): RequestInit {
  const method = (previous.method ?? 'GET').toUpperCase()
  const switchesToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST')
  if (!switchesToGet && typeof ReadableStream !== 'undefined'
    && previous.body instanceof ReadableStream) {
    throw new Error('MCP HTTP transport cannot replay a streaming body across a redirect')
  }
  const headers = crossesOrigin ? new Headers() : new Headers(previous.headers)
  if (switchesToGet) {
    headers.delete('content-length')
    headers.delete('content-type')
  }
  return {
    ...previous,
    redirect: 'manual',
    headers,
    ...(switchesToGet ? { method: 'GET', body: null } : {}),
  }
}

async function cancelResponse(response: Response, timeoutMs: number): Promise<void> {
  if (response.body === null) return
  await waitForSettlement(response.body.cancel().catch(() => undefined), timeoutMs)
}

export function mergeHeaders(base: RequestInit['headers'], extra: RequestInit['headers']): Headers {
  const headers = new Headers(base)
  new Headers(extra).forEach((value, key) => { headers.set(key, value) })
  return headers
}

function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa') || !hostname.includes('.')) return true
  if (hostname.includes(':')) return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  const [first = 0, second = 0] = octets
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
}
