import { waitForSettlement } from '@ai-agent-sdk/core'
import type { McpHttpClientOptions } from './api-types.ts'
import type { McpFetch } from './public-types.ts'
import { createAbortTimeoutScope, positiveSafeInteger, raceAbort } from './runtime-helpers.ts'
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
  if (!options.allowPrivateNetwork && isPrivateHostname(url.hostname)) {
    throw new TypeError(`MCP HTTP endpoint host '${url.hostname}' is private or local`)
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use https under the configured policy')
  }
  if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
    throw new TypeError(`MCP HTTP endpoint origin '${url.origin}' is not allowed`)
  }
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
    const pending = (async (): Promise<Response> => {
      const signal = scope.signal
      signal.throwIfAborted()
      let currentUrl = validateHttpEndpoint(input, options)
      await validateBeforeFetch(currentUrl, options, signal)
      let requestInit: RequestInit = { ...init, signal, redirect: 'manual' }
      let response: Response
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted()
        const fetching = Promise.resolve(baseFetch(currentUrl, requestInit))
        try { response = await raceAbort(fetching, signal) }
        catch (error) {
          // A custom fetch may ignore abort and deliver a body after the public
          // request has ended. Retain cleanup ownership without delaying rejection.
          void fetching.then(late => cancelResponse(late, options.teardownTimeoutMs), () => undefined)
            .catch(() => undefined)
          throw error
        }
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
        const crossesOrigin = nextUrl.origin !== currentUrl.origin
        requestInit = redirectInit(requestInit, response.status, crossesOrigin)
        currentUrl = nextUrl
      }
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
        response.body, options.maxTransportBytes, options.teardownTimeoutMs, signal, scope.dispose,
      )
      return new Response(limited, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    })()
    return raceAbort(pending, scope.signal).catch(error => { scope.dispose(); throw error })
  }) as McpFetch
}

function limitedResponseBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  teardownTimeoutMs: number,
  signal: AbortSignal,
  dispose: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let received = 0
  let settled = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const settle = (): void => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    dispose()
  }
  const abort = (): void => {
    if (settled) return
    const reason = signal.reason ?? new Error('MCP HTTP response body was aborted')
    settle()
    controller?.error(reason)
    void waitForSettlement(reader.cancel(reason).catch(() => undefined), teardownTimeoutMs)
  }
  const source = {
    type: undefined,
    start(value: ReadableStreamDefaultController<Uint8Array>) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(value: ReadableStreamDefaultController<Uint8Array>) {
      if (settled) return
      try {
        const next = await raceAbort(reader.read(), signal)
        if (next.done) { settle(); value.close(); return }
        received += next.value.byteLength
        if (received > maxBytes) {
          const error = new Error(`MCP HTTP response exceeds the ${maxBytes}-byte limit`)
          settle()
          value.error(error)
          await waitForSettlement(reader.cancel(error).catch(() => undefined), teardownTimeoutMs)
          return
        }
        value.enqueue(next.value)
      } catch (error) {
        if (settled) return
        settle()
        value.error(error)
      }
    },
    async cancel(reason: unknown) {
      settle()
      await waitForSettlement(reader.cancel(reason).catch(() => undefined), teardownTimeoutMs)
    },
  }
  return new ReadableStream<Uint8Array>(source)
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
