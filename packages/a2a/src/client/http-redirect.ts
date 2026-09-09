import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECT_HOPS = 5

export interface A2ARedirectOptions {
  readonly allowRedirects: boolean
  readonly signal: AbortSignal
  readonly teardownTimeoutMs: number
  readonly validateEndpoint: (url: string | URL) => URL
}

/** Apply redirect policy manually so every target is validated before contact. */
export async function fetchA2AEndpoint(
  baseFetch: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: A2ARedirectOptions,
): Promise<Response> {
  let currentInput = input
  let currentUrl = options.validateEndpoint(inputUrl(input))
  let requestInit: RequestInit = { ...init, signal: options.signal, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    const response = await raceAbort(
      Promise.resolve(baseFetch(currentInput, requestInit)), options.signal,
    )
    const observableFollow = response.redirected === true || response.type === 'opaqueredirect'
      || (response.url.length > 0 && response.url !== currentUrl.href)
    if (observableFollow) {
      await cancelResponse(response, options.teardownTimeoutMs)
      throw new Error('A2A HTTP transport rejected an already-followed redirect')
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response
    if (!options.allowRedirects) {
      await cancelResponse(response, options.teardownTimeoutMs)
      throw new Error('A2A HTTP transport rejected a redirect')
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      await cancelResponse(response, options.teardownTimeoutMs)
      throw new Error(`A2A HTTP transport exceeded the ${MAX_REDIRECT_HOPS}-redirect limit`)
    }
    const location = response.headers.get('location')
    if (location === null) {
      await cancelResponse(response, options.teardownTimeoutMs)
      throw new Error('A2A HTTP transport received a redirect without a location')
    }
    const nextUrl = options.validateEndpoint(new URL(location, currentUrl))
    await cancelResponse(response, options.teardownTimeoutMs)
    requestInit = redirectedInit(requestInit, input, response.status, nextUrl.origin !== currentUrl.origin)
    currentInput = nextUrl
    currentUrl = nextUrl
  }
}

function redirectedInit(
  previous: RequestInit,
  original: Parameters<typeof fetch>[0],
  status: number,
  crossesOrigin: boolean,
): RequestInit {
  const inputMethod = typeof Request !== 'undefined' && original instanceof Request
    ? original.method
    : undefined
  const method = (previous.method ?? inputMethod ?? 'GET').toUpperCase()
  const switchesToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST')
  const inputHasBody = typeof Request !== 'undefined' && original instanceof Request && original.body !== null
  if (!switchesToGet && (inputHasBody
    || (typeof ReadableStream !== 'undefined' && previous.body instanceof ReadableStream))) {
    throw new Error('A2A HTTP transport cannot replay a streaming request across a redirect')
  }
  const sourceHeaders = previous.headers
    ?? (typeof Request !== 'undefined' && original instanceof Request ? original.headers : undefined)
  const headers = crossesOrigin ? new Headers() : new Headers(sourceHeaders)
  if (switchesToGet) {
    headers.delete('content-length')
    headers.delete('content-type')
  }
  return { ...previous, redirect: 'manual', headers,
    ...(switchesToGet ? { method: 'GET', body: null } : {}) }
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' || input instanceof URL ? input.toString() : input.url
}

async function cancelResponse(response: Response, timeoutMs: number): Promise<void> {
  if (response.body === null) return
  await waitForSettlement(response.body.cancel().catch(() => undefined), timeoutMs)
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('A2A operation aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('A2A operation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
