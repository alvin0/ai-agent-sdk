import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedOptions } from './fetch-options.ts'
const RETRYABLE_STATUSES = new Set([408, 425, 429])
const MAX_RETRY_AFTER_MS = 60_000
export class ObservationProtocolError extends Error {
  override readonly name = 'ObservationProtocolError'
}

export function retryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599)
}

export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1_000)
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now))
}

export function backoffMs(attempt: number, options: ResolvedOptions): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** Math.max(0, attempt - 1)))
  const random = options.random()
  const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0
  return Math.floor(cap * unit)
}

export function combinedSignal(external: AbortSignal, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timeout = setTimeout(() =>
    controller.abort(new DOMException('observation request timed out', 'TimeoutError')), timeoutMs)
  const abort = () => controller.abort(external.reason ?? new DOMException('observation export aborted', 'AbortError'))
  if (external.aborted) abort()
  else external.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    clear() { clearTimeout(timeout); external.removeEventListener('abort', abort) },
  }
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('observation export aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('observation export aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('observation export aborted')) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export async function cancelBody(response: Response): Promise<void> {
  if (response.body === null) return
  await waitForSettlement(response.body.cancel().catch(() => undefined), 1_000)
}

export async function boundedText(response: Response, options: ResolvedOptions, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > options.maxAckBytes) {
    await cancelBody(response)
    throw new RangeError('observation acknowledgment exceeds its byte limit')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let bytes = 0
  let chunks = 0
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) return output + decoder.decode()
      if (next.value === undefined) continue
      bytes += next.value.byteLength
      chunks++
      if (bytes > options.maxAckBytes || chunks > options.maxAckChunks) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 1_000)
        throw new RangeError('observation acknowledgment exceeds its resource limit')
      }
      output += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export async function validateNoRedirectResponse(response: Response, endpoint: URL): Promise<void> {
  const redirectStatus = response.status >= 300 && response.status < 400
  const opaqueRedirect = response.type === 'opaqueredirect'
  const responseUrlChanged = response.url.length > 0 && response.url !== endpoint.href
  if (response.redirected || redirectStatus || opaqueRedirect || responseUrlChanged) {
    await cancelBody(response)
    throw new ObservationProtocolError('observation exporter rejected a redirect before following it')
  }
  if (response.url.length > 0) {
    let responseOrigin: string
    try { responseOrigin = new URL(response.url).origin } catch {
      throw new ObservationProtocolError('observation response URL is invalid')
    }
    if (responseOrigin !== endpoint.origin) {
      throw new ObservationProtocolError('observation response origin does not match its endpoint')
    }
  }
}

