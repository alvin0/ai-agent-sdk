import { limitedResponseBody } from './http-response-body.ts'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import type { McpHttpClientOptions } from './api-types.ts'
import type { McpFetch } from './public-types.ts'
import { createAbortTimeoutScope, positiveSafeInteger, raceAbort, timeoutMilliseconds } from './runtime-helpers.ts'
import { MCP_CLIENT_DEFAULTS, MCP_HTTP_REDIRECT_STATUSES } from './config.ts'

export interface McpHttpSecurityOptions {
  readonly allowedOrigins?: readonly string[]
  readonly requireHttps: boolean
  readonly allowPrivateNetwork: boolean
  readonly allowRedirects: boolean
  readonly validateEndpoint?: (url: URL, signal: AbortSignal) => void | Promise<void>
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
    requireHttps: options.requireHttps !== false,
    allowPrivateNetwork: options.allowPrivateNetwork === true,
    allowRedirects: options.allowRedirects === true,
    ...(options.validateEndpoint === undefined ? {} : { validateEndpoint: options.validateEndpoint }),
    maxTransportBytes: positiveSafeInteger(
      options.maxTransportBytes ?? MCP_CLIENT_DEFAULTS.maxTransportBytes, 'maxTransportBytes',
    ),
    timeoutMs: timeoutMilliseconds(
      options.operationTimeoutMs ?? MCP_CLIENT_DEFAULTS.operationTimeoutMs, 'operationTimeoutMs',
    ),
    teardownTimeoutMs: timeoutMilliseconds(
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
  if (!options.allowPrivateNetwork && isPrivateHostname(url.hostname)) {
    throw new TypeError(`MCP HTTP endpoint host '${url.hostname}' is private or local`)
  }
  validateEndpointPolicy(url, options)
  return url
}

export function createGuardedMcpFetch(baseFetch: McpFetch, options: McpHttpSecurityOptions): McpFetch {
  if (typeof baseFetch !== 'function') throw new TypeError('MCP HTTP transport requires fetch')
  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    const scope = createAbortTimeoutScope(
      options.timeoutMs,
      `MCP HTTP operation exceeded its ${options.timeoutMs}ms deadline`,
      init?.signal ?? undefined,
    )
    const pending = executeGuardedFetch(baseFetch, options, { input, init, scope })
    return raceAbort(pending, scope.signal).catch(error => { scope.dispose(); throw error })
  }) as McpFetch
}

async function validateBeforeFetch(
  url: URL,
  options: McpHttpSecurityOptions,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (options.validateEndpoint === undefined) return
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return options.validateEndpoint?.(new URL(url), signal)
  })
  await raceAbort(pending, signal)
  signal.throwIfAborted()
}

function redirectInit(previous: RequestInit, status: number, crossesOrigin: boolean): RequestInit {
  const method = (previous.method ?? 'GET').toUpperCase()
  const switchesToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST')
  assertReplayable(previous, switchesToGet)
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
  return isPrivateIpv4(hostname)
}

async function executeGuardedFetch(
  baseFetch: McpFetch, options: McpHttpSecurityOptions, request: {
    input: string | URL; init: RequestInit | undefined; scope: ReturnType<typeof createAbortTimeoutScope>
  },
): Promise<Response> {
  const { input, init, scope } = request
  const signal = scope.signal
  signal.throwIfAborted()
  let currentUrl = validateHttpEndpoint(input, options)
  await validateBeforeFetch(currentUrl, options, signal)
  let requestInit: RequestInit = { ...init, signal, redirect: 'manual' }
  let response: Response
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted()
    response = await fetchWithCleanup(baseFetch, currentUrl, { requestInit, signal }, options.teardownTimeoutMs)
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
    await validateBeforeFetch(nextUrl, options, signal)
    requestInit = redirectInit(requestInit, response.status, nextUrl.origin !== currentUrl.origin)
    currentUrl = nextUrl
  }
  return validateResponse(response, currentUrl, options, scope)
}

async function validateResponse(
  response: Response, currentUrl: URL, options: McpHttpSecurityOptions,
  scope: ReturnType<typeof createAbortTimeoutScope>,
): Promise<Response> {
  if (response.url.length > 0) {
    try {
      const responseUrl = validateHttpEndpoint(response.url, options)
      if (responseUrl.origin !== currentUrl.origin) {
        throw new Error('MCP HTTP transport response escaped the validated origin')
      }
    } catch (error) {
      await cancelResponse(response, options.teardownTimeoutMs)
      throw error
    }
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > options.maxTransportBytes) {
    if (response.body !== null) {
      await waitForSettlement(response.body.cancel().catch(() => undefined), options.teardownTimeoutMs)
    }
    throw new Error(`MCP HTTP response exceeds the ${options.maxTransportBytes}-byte limit`)
  }
  if (response.body === null) { scope.dispose(); return response }
  const limited = limitedResponseBody(
    response.body, options.maxTransportBytes, options.teardownTimeoutMs, scope,
  )
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function validateEndpointPolicy(url: URL, options: McpHttpSecurityOptions): void {
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use https under the configured policy')
  }
  if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
    throw new TypeError(`MCP HTTP endpoint origin '${url.origin}' is not allowed`)
  }
}

function isPrivateSubnet(first: number, second: number): boolean {
  return (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
}

function assertReplayable(previous: RequestInit, switchesToGet: boolean): void {
  if (!switchesToGet && typeof ReadableStream !== 'undefined'
    && previous.body instanceof ReadableStream) {
    throw new Error('MCP HTTP transport cannot replay a streaming body across a redirect')
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (!validIpv4Octets(octets)) {
    return false
  }
  const [first = 0, second = 0] = octets
  return isPrivateFirstOctet(first)
    || (first === 100 && second >= 64 && second <= 127)
    || isPrivateSubnet(first, second)
}

async function fetchWithCleanup(
  baseFetch: McpFetch, currentUrl: URL, request: { requestInit: RequestInit; signal: AbortSignal },
  teardownTimeoutMs: number,
): Promise<Response> {
  const { requestInit, signal } = request
  const fetching = Promise.resolve(baseFetch(currentUrl, requestInit))
  try { return await raceAbort(fetching, signal) }
  catch (error) {
    // A custom fetch may ignore abort and deliver a body after the public
    // request has ended. Retain cleanup ownership without delaying rejection.
    void fetching.then(late => cancelResponse(late, teardownTimeoutMs), () => undefined)
      .catch(() => undefined)
    throw error
  }
}

function validIpv4Octets(octets: number[]): boolean {
  return !(octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255))
}

function isPrivateFirstOctet(first: number): boolean {
  return first === 0 || first === 10 || first === 127 || first >= 224
}
