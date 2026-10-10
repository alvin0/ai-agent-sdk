import { abortableDelay } from './fetch-transport.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_BASE_DELAY_MS = 250
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_BATCH_EVENTS = 256
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
const DEFAULT_MAX_ACK_BYTES = 64 * 1024
const DEFAULT_MAX_ACK_CHUNKS = 1_000
const FORBIDDEN_HEADER_NAMES = new Set(['content-length', 'content-type', 'host', 'idempotency-key'])

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

export interface ResolvedOptions {
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
    if (FORBIDDEN_HEADER_NAMES.has(normalized)) {
      throw new TypeError(`observation header ${name} is managed by the exporter`)
    }
    if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new TypeError(`observation header ${name} is invalid`)
    }
    output[normalized] = value
  }
  return Object.freeze(output)
}

export function resolveOptions(options: FetchObservationExporterOptions): ResolvedOptions {
  validateInjectedFunctions(options)
  return Object.freeze({
    endpoint: endpointOf(options.endpoint, options.allowInsecureHttp ?? false),
    headers: headersOf(options.headers),
    fetch: options.fetch ?? globalThis.fetch,
    ...retryOptions(options),
    ...resourceLimits(options),
    random: options.random ?? Math.random,
    delay: options.delay ?? abortableDelay,
    now: options.now ?? Date.now,
  })
}


function validateInjectedFunctions(options: FetchObservationExporterOptions) {
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
}

function retryOptions(options: FetchObservationExporterOptions) {
  return {
    requestTimeoutMs: positiveSafeInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    maxAttempts: positiveSafeInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts'),
    baseDelayMs: nonNegativeFinite(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, 'baseDelayMs'),
    maxDelayMs: nonNegativeFinite(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 'maxDelayMs'),
  }
}

function resourceLimits(options: FetchObservationExporterOptions) {
  return {
    maxBatchEvents: positiveSafeInteger(options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS, 'maxBatchEvents'),
    maxBatchBytes: positiveSafeInteger(options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 'maxBatchBytes'),
    maxAckBytes: positiveSafeInteger(options.maxAckBytes ?? DEFAULT_MAX_ACK_BYTES, 'maxAckBytes'),
    maxAckChunks: positiveSafeInteger(options.maxAckChunks ?? DEFAULT_MAX_ACK_CHUNKS, 'maxAckChunks'),
  }
}
