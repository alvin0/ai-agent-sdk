import { waitForSettlement, type ObservationBoundary } from '@ai-agent-sdk/core'
import type {
  ExportAck,
  ObservationBatch,
  ObservationExporter,
} from '@ai-agent-sdk/core/observability'
import {
  defineObservationExporter,
  type ObservationDeliveryBatch,
  type ObservationExporterPlugin,
} from '@ai-agent-sdk/core/observability'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 250
const DEFAULT_MAX_DELAY_MS = 30_000
const MAX_RETRY_AFTER_MS = 60_000
const DEFAULT_MAX_BATCH_EVENTS = 256
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
const DEFAULT_MAX_ACK_BYTES = 64 * 1024
const DEFAULT_MAX_ACK_CHUNKS = 1_000
const RETRYABLE_STATUSES = new Set([408, 425, 429])
const FORBIDDEN_HEADER_NAMES = new Set(['content-length', 'content-type', 'host', 'idempotency-key'])

class ObservationProtocolError extends Error {
  override readonly name = 'ObservationProtocolError'
}

export interface FetchObservationExporterOptions {
  readonly id?: string
  readonly endpoint: string | URL
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  /** Permit cleartext only for localhost/loopback test endpoints. */
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
  readonly maxAckBytes?: number
  readonly maxAckChunks?: number
  /** Deterministic injection for tests; defaults to `Math.random`. */
  readonly random?: () => number
  /** Timer injection for tests; defaults to an abortable Web timer. */
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Clock injection used only for HTTP-date `Retry-After`. */
  readonly now?: () => number
}

interface ResolvedOptions {
  readonly endpoint: URL
  readonly headers: Readonly<Record<string, string>>
  readonly fetch: typeof fetch
  readonly requestTimeoutMs: number
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly maxBatchEvents: number
  readonly maxBatchBytes: number
  readonly maxAckBytes: number
  readonly maxAckChunks: number
  readonly random: () => number
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly now: () => number
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be a non-negative finite number`)
  return value
}

function endpointOf(value: string | URL, allowInsecureHttp: boolean): URL {
  const endpoint = new URL(value)
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new TypeError('observation endpoint must not contain credentials')
  }
  const local = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '[::1]' || endpoint.hostname === '::1'
  if (endpoint.protocol !== 'https:' && !(allowInsecureHttp && endpoint.protocol === 'http:' && local)) {
    throw new TypeError('observation endpoint must use https')
  }
  return endpoint
}

function headersOf(headers: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const output = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase()
    if (FORBIDDEN_HEADER_NAMES.has(normalized)) throw new TypeError(`observation header ${name} is managed by the exporter`)
    if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new TypeError(`observation header ${name} is invalid`)
    }
    output[normalized] = value
  }
  return Object.freeze(output)
}

function resolveOptions(options: FetchObservationExporterOptions): ResolvedOptions {
  if (typeof options?.fetch !== 'function' && typeof globalThis.fetch !== 'function') {
    throw new TypeError('Fetch observation exporter requires fetch')
  }
  if (options.random !== undefined && typeof options.random !== 'function') {
    throw new TypeError('random must be a function')
  }
  if (options.delay !== undefined && typeof options.delay !== 'function') {
    throw new TypeError('delay must be a function')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function')
  }
  return Object.freeze({
    endpoint: endpointOf(options.endpoint, options.allowInsecureHttp ?? false),
    headers: headersOf(options.headers),
    fetch: options.fetch ?? globalThis.fetch,
    requestTimeoutMs: positiveSafeInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    maxAttempts: positiveSafeInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts'),
    baseDelayMs: nonNegativeFinite(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, 'baseDelayMs'),
    maxDelayMs: nonNegativeFinite(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 'maxDelayMs'),
    maxBatchEvents: positiveSafeInteger(options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS, 'maxBatchEvents'),
    maxBatchBytes: positiveSafeInteger(options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 'maxBatchBytes'),
    maxAckBytes: positiveSafeInteger(options.maxAckBytes ?? DEFAULT_MAX_ACK_BYTES, 'maxAckBytes'),
    maxAckChunks: positiveSafeInteger(options.maxAckChunks ?? DEFAULT_MAX_ACK_CHUNKS, 'maxAckChunks'),
    random: options.random ?? Math.random,
    delay: options.delay ?? abortableDelay,
    now: options.now ?? Date.now,
  })
}

function retryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599)
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1_000)
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now))
}

function backoffMs(attempt: number, options: ResolvedOptions): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** Math.max(0, attempt - 1)))
  const random = options.random()
  const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0
  return Math.floor(cap * unit)
}

function combinedSignal(external: AbortSignal, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('observation request timed out', 'TimeoutError')), timeoutMs)
  const abort = () => controller.abort(external.reason ?? new DOMException('observation export aborted', 'AbortError'))
  if (external.aborted) abort()
  else external.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    clear() { clearTimeout(timeout); external.removeEventListener('abort', abort) },
  }
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('observation export aborted')) }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body === null) return
  await waitForSettlement(response.body.cancel().catch(() => undefined), 1_000)
}

async function boundedText(response: Response, options: ResolvedOptions, signal: AbortSignal): Promise<string> {
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

async function validateNoRedirectResponse(response: Response, endpoint: URL): Promise<void> {
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

/** A remote-acknowledged exporter using only Fetch and Web streams. */
export class FetchObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[] = Object.freeze(['remote-acknowledged'])
  private readonly options: ResolvedOptions

  constructor(options: FetchObservationExporterOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('Fetch observation exporter options are required')
    }
    this.id = options.id ?? 'fetch'
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(this.id)) {
      throw new TypeError('Fetch observation exporter id must be a safe 1-64 character identifier')
    }
    this.options = resolveOptions(options)
  }

  async export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    const result = await sendBatch(this.options, batch.batchId, batch.events.length, batch, signal)
    return Object.freeze({ batchId: batch.batchId, ...result })
  }
}

interface BatchSendResult {
  readonly accepted: boolean
  readonly retryable: boolean
}

async function sendBatch(
  options: ResolvedOptions,
  batchId: string,
  itemCount: number,
  batch: unknown,
  signal: AbortSignal,
): Promise<BatchSendResult> {
  if (itemCount > options.maxBatchEvents) return Object.freeze({ accepted: false, retryable: false })
  const body = JSON.stringify(batch)
  if (new TextEncoder().encode(body).byteLength > options.maxBatchBytes) {
    return Object.freeze({ accepted: false, retryable: false })
  }
  // Web IDL fetch rejects a property-call receiver such as `options.fetch(...)`
  // in browsers. Capture it as a standalone callable so native Window/Worker
  // fetch and injected implementations share the same invocation contract.
  const dispatch = options.fetch

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('observation export aborted')
    const request = combinedSignal(signal, options.requestTimeoutMs)
    let retryDelay: number | undefined
    try {
        const response = await raceAbort(Promise.resolve(dispatch(options.endpoint, {
          method: 'POST',
          headers: {
            ...options.headers,
            'content-type': 'application/json',
            'idempotency-key': batchId,
          },
          body,
          redirect: 'manual',
          signal: request.signal,
        })), request.signal)
        await validateNoRedirectResponse(response, options.endpoint)
        if (response.status === 204) {
          await cancelBody(response)
          return Object.freeze({ accepted: true, retryable: false })
        }
        if (response.status >= 200 && response.status < 300) {
          const raw = await boundedText(response, options, request.signal)
          let parsed: unknown
          try { parsed = JSON.parse(raw) } catch { parsed = undefined }
          const acceptedBatchId = typeof parsed === 'object' && parsed !== null
            ? Reflect.get(parsed, 'acceptedBatchId')
            : undefined
          return Object.freeze({
            accepted: acceptedBatchId === batchId,
            retryable: false,
          })
        }
        const retryable = retryableStatus(response.status)
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), options.now())
        await cancelBody(response)
        if (!retryable || attempt === options.maxAttempts) {
          return Object.freeze({ accepted: false, retryable })
        }
        retryDelay = retryAfter ?? backoffMs(attempt, options)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (error instanceof ObservationProtocolError || error instanceof RangeError) {
        return Object.freeze({ accepted: false, retryable: false })
      }
      if (attempt === options.maxAttempts) {
        return Object.freeze({ accepted: false, retryable: true })
      }
      retryDelay = backoffMs(attempt, options)
    } finally {
      request.clear()
    }
    await raceAbort(Promise.resolve(options.delay(retryDelay ?? 0, signal)), signal)
  }
  return Object.freeze({ accepted: false, retryable: true })
}

/** Recommended inert runtime exporter; transport begins only when core exports a batch. */
export function fetchObservationExporter(
  options: FetchObservationExporterOptions,
): ObservationExporterPlugin {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Fetch observation exporter options are required')
  }
  const id = options.id ?? 'fetch'
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(id)) {
    throw new TypeError('Fetch observation exporter id must be a safe 1-64 character identifier')
  }
  const captured = resolveOptions(options)
  return defineObservationExporter({
    id,
    supportedBoundaries: ['remote-acknowledged'],
    async export(batch: ObservationDeliveryBatch, signal: AbortSignal) {
      const result = await sendBatch(
        captured,
        batch.id,
        batch.events.length + batch.runRecords.length,
        batch,
        signal,
      )
      return Object.freeze({
        batchId: batch.id,
        acceptedEventIds: result.accepted ? batch.events.map(event => event.eventId) : [],
        acceptedRunIds: result.accepted ? batch.runRecords.map(record => record.runId) : [],
      })
    },
  })
}
