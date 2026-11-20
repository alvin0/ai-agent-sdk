import { AgentSdkError, type SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import type { AntigravityOAuthOptions } from './types.ts'

export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSdkError('Antigravity returned an invalid object', 'MALFORMED_RESPONSE')
  }
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 65_536) {
    throw new AgentSdkError(`Antigravity ${label} is missing or invalid`, 'MALFORMED_RESPONSE')
  }
  return value
}

export function endpoint(value: string, allowInsecureHttp = false): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:'))) {
    throw new TypeError('Antigravity endpoints must use HTTPS without credentials or fragments')
  }
  return url
}

/** Bound fetch and every body pull, including injected implementations that ignore AbortSignal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(signal.reason) }
    // Observe settlement even when already cancelled: the pending operation may reject later.
    void promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function requestBounds(options: AntigravityOAuthOptions) {
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const maxBytes = options.maxResponseBytes ?? 1_048_576
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid Antigravity HTTP limits')
  return { timeoutMs, maxBytes }
}

function checkRedirect(response: Response): void {
  if (response.redirected || response.type === 'opaqueredirect') {
    void response.body?.cancel().catch(() => undefined)
    throw new AgentSdkError('Antigravity refused a redirected response', 'ANTIGRAVITY_HTTP_ERROR')
  }
}

export class AntigravityHttpError extends AgentSdkError {
  constructor(readonly status: number, code: string) {
    super(`Antigravity request failed (HTTP ${status})`, code)
  }
}

function checkResponse(response: Response): void {
  checkRedirect(response)
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    const codes: Record<number, string> = {
      401: 'ANTIGRAVITY_AUTH_REVOKED', 403: 'ANTIGRAVITY_ACCESS_DENIED', 429: 'RATE_LIMIT',
    }
    throw new AntigravityHttpError(response.status, codes[response.status] ?? 'ANTIGRAVITY_HTTP_ERROR')
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    void response.body?.cancel().catch(() => undefined)
    throw new AgentSdkError('Antigravity returned a non-JSON response', 'MALFORMED_RESPONSE')
  }
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal) {
  if (response.body === null) throw new AgentSdkError('Antigravity returned no body', 'MALFORMED_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let chunks = 0
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal)
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes || ++chunks > 16_384) {
        throw new AgentSdkError('Antigravity response exceeds configured limits', 'MALFORMED_RESPONSE')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    try { return object(JSON.parse(text + decoder.decode()) as unknown) }
    catch { throw new AgentSdkError('Antigravity returned invalid JSON', 'MALFORMED_RESPONSE') }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function requestJson(
  url: string, init: RequestInit, options: AntigravityOAuthOptions,
): Promise<Record<string, unknown>> {
  const { timeoutMs, maxBytes } = requestBounds(options)
  const target = endpoint(url, options.allowInsecureHttp)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new AgentSdkError('Antigravity request timed out', 'TRANSPORT'))
  }, timeoutMs)
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
  try {
    signal.throwIfAborted()
    const pending = Promise.resolve((options.fetch ?? globalThis.fetch)(target, {
      ...init, redirect: 'manual', signal,
    }))
    void pending.then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => undefined)
    }, () => undefined)
    const response = await abortable(pending, signal)
    checkResponse(response)
    return await readJson(response, maxBytes, signal)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof AgentSdkError) throw error
    // Injected fetch errors can contain credentials. Never retain their messages or causes.
    throw new AgentSdkError('Antigravity request failed', 'TRANSPORT')
  } finally { clearTimeout(timer) }
}
