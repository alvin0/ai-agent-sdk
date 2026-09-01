import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DEFAULT_MAX_RECORDS = 20_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const MAX_STRING_CHARS = 2_000
const MAX_ARRAY_ITEMS = 256
const MAX_OBJECT_KEYS = 256
const MAX_DEPTH = 10

const SECRET_KEY = /^(authorization|cookie|credentials?|password|secret|tokens?|api[-_]?key|client[-_]?secret)$/i
const CONTENT_KEY = /^(content|data|messages|prompt|rawArguments|reasoning|stderr|stdout|system|text)$/i

export type HumanArtifactStatus = 'passed' | 'failed' | 'aborted' | 'dry-run'

export interface HumanArtifactInvariant {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface HumanArtifactRecorderOptions {
  readonly harness: string
  readonly runId?: string
  readonly resultsRoot?: string
  readonly maxRecords?: number
  readonly maxBytes?: number
  readonly startedAt?: Date
}

export interface HumanArtifactFinishInput {
  readonly status: HumanArtifactStatus
  readonly config?: Readonly<Record<string, unknown>>
  readonly invariants?: readonly HumanArtifactInvariant[]
  readonly metrics?: Readonly<Record<string, unknown>>
  readonly error?: unknown
}

export interface HumanArtifactSummary {
  readonly schemaVersion: 1
  readonly harness: string
  readonly runId: string
  readonly status: HumanArtifactStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly environment: {
    readonly node: string
    readonly platform: NodeJS.Platform
    readonly arch: string
  }
  readonly artifact: {
    readonly directory: string
    readonly events: string
    readonly records: number
    readonly bytes: number
    readonly droppedRecords: number
    readonly sha256: string
  }
  readonly config?: unknown
  readonly invariants: readonly HumanArtifactInvariant[]
  readonly metrics?: unknown
  readonly error?: unknown
}

interface ArtifactRecord {
  readonly sequence: number
  readonly at: string
  readonly monotonicMs: number
  readonly kind: string
  readonly data: unknown
}

/**
 * Bounded, support-safe JSON/JSONL evidence shared by human and stress harnesses.
 * High-risk content is reduced to length + digest before it reaches the record buffer.
 */
export class HumanArtifactRecorder {
  readonly harness: string
  readonly runId: string
  readonly directory: string
  readonly summaryPath: string
  readonly eventsPath: string

  private readonly started: number
  private readonly startedAt: string
  private readonly maxRecords: number
  private readonly maxBytes: number
  private readonly records: ArtifactRecord[] = []
  private bytes = 0
  private droppedRecords = 0
  private finished = false

  constructor(options: HumanArtifactRecorderOptions) {
    this.harness = safeSegment(options.harness, 'harness')
    this.runId = safeSegment(options.runId ?? defaultRunId(), 'runId')
    const root = resolve(options.resultsRoot ?? join('test-human', 'results', this.harness))
    this.directory = join(root, this.runId)
    this.summaryPath = join(this.directory, 'summary.json')
    this.eventsPath = join(this.directory, 'events.jsonl')
    const started = options.startedAt?.getTime() ?? Date.now()
    if (!Number.isFinite(started)) throw new TypeError('artifact startedAt must be valid')
    this.started = started
    this.startedAt = new Date(started).toISOString()
    this.maxRecords = boundedPositive(options.maxRecords ?? DEFAULT_MAX_RECORDS, 'maxRecords')
    this.maxBytes = boundedPositive(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
  }

  record(kind: string, data: unknown = {}): boolean {
    if (this.finished) throw new Error('human artifact recorder is already finished')
    const safeKind = safeSegment(kind, 'record kind')
    const record: ArtifactRecord = Object.freeze({
      sequence: this.records.length + this.droppedRecords + 1,
      at: new Date().toISOString(),
      monotonicMs: Math.max(0, Date.now() - this.started),
      kind: safeKind,
      data: safeSanitizeArtifactValue(data),
    })
    const encodedBytes = Buffer.byteLength(JSON.stringify(record)) + 1
    if (this.records.length >= this.maxRecords || this.bytes + encodedBytes > this.maxBytes) {
      this.droppedRecords++
      return false
    }
    this.records.push(record)
    this.bytes += encodedBytes
    return true
  }

  async finish(input: HumanArtifactFinishInput): Promise<HumanArtifactSummary> {
    if (this.finished) throw new Error('human artifact recorder is already finished')
    this.finished = true
    const finished = Date.now()
    const eventLines = this.records.map(record => JSON.stringify(record)).join('\n')
    const eventsPayload = `${eventLines}${eventLines.length === 0 ? '' : '\n'}`
    const invariants = Object.freeze((input.invariants ?? []).map(invariant => Object.freeze({
      name: boundedString(invariant.name),
      passed: invariant.passed,
      ...(invariant.detail === undefined ? {} : { detail: boundedString(invariant.detail) }),
    })))
    const summary: HumanArtifactSummary = Object.freeze({
      schemaVersion: 1,
      harness: this.harness,
      runId: this.runId,
      status: input.status,
      startedAt: this.startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - this.started),
      environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
      artifact: Object.freeze({
        directory: this.directory,
        events: this.eventsPath,
        records: this.records.length,
        bytes: Buffer.byteLength(eventsPayload),
        droppedRecords: this.droppedRecords,
        sha256: createHash('sha256').update(eventsPayload).digest('hex'),
      }),
      ...(input.config === undefined ? {} : { config: safeSanitizeArtifactValue(input.config) }),
      invariants,
      ...(input.metrics === undefined ? {} : { metrics: safeSanitizeArtifactValue(input.metrics) }),
      ...(input.error === undefined ? {} : { error: sanitizeArtifactError(input.error) }),
    })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await Promise.all([
      writeFile(this.eventsPath, eventsPayload, { encoding: 'utf8', mode: 0o600 }),
      writeFile(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
    ])
    return summary
  }
}

export function sanitizeArtifactValue(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key) && !isNumericMetricRecord(value)) return '<redacted>'
  if (CONTENT_KEY.test(key)) return contentFingerprint(value)
  if (typeof value === 'string') return boundedString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '<max-depth>'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeArtifactValue(item, key, depth + 1))
    return value.length <= MAX_ARRAY_ITEMS
      ? items
      : [...items, `<${value.length - MAX_ARRAY_ITEMS} items omitted>`]
  }
  if (value instanceof Error) return sanitizeArtifactError(value)
  const entries = Object.entries(value as Record<string, unknown>)
  const output: Record<string, unknown> = {}
  for (const [childKey, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    output[childKey] = sanitizeArtifactValue(child, childKey, depth + 1)
  }
  if (entries.length > MAX_OBJECT_KEYS) output._omittedKeys = entries.length - MAX_OBJECT_KEYS
  return output
}

function isNumericMetricRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length > 0 && entries.every(([, item]) => typeof item === 'number' && Number.isFinite(item))
}

function safeSanitizeArtifactValue(value: unknown): unknown {
  try { return sanitizeArtifactValue(value) }
  catch (error: unknown) {
    return Object.freeze({
      sanitizationFailed: true,
      error: error instanceof Error ? boundedString(error.name) : 'UnknownError',
    })
  }
}

function sanitizeArtifactError(error: unknown): unknown {
  if (!(error instanceof Error)) return sanitizeArtifactValue(error)
  const code = Reflect.get(error, 'code')
  return Object.freeze({
    name: boundedString(error.name),
    message: boundedString(error.message),
    ...(typeof code === 'string' ? { code: boundedString(code) } : {}),
  })
}

function contentFingerprint(value: unknown): unknown {
  const encoded = typeof value === 'string' ? value : safeFingerprintEncoding(value)
  if (encoded === undefined) return { chars: 0, sha256: createHash('sha256').update('').digest('hex') }
  return Object.freeze({
    chars: encoded.length,
    bytes: Buffer.byteLength(encoded),
    sha256: createHash('sha256').update(encoded).digest('hex'),
  })
}

function safeFingerprintEncoding(value: unknown): string | undefined {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === 'bigint') return current.toString()
      if (current !== null && typeof current === 'object') {
        if (seen.has(current)) return '<circular>'
        seen.add(current)
      }
      return current
    })
  } catch {
    try { return String(value) } catch { return '<unprintable>' }
  }
}

function boundedString(value: string): string {
  return value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS - 32)}… <${value.length} chars>`
}

function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${field} must be one safe path segment of at most 128 characters`)
  }
  return value
}

function boundedPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive integer`)
  return value
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}-${randomUUID().slice(0, 8)}`
}
