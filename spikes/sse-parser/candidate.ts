/**
 * Non-production, byte-oriented SSE parser candidate.
 *
 * This spike deliberately owns decoding and framing together so its resource
 * limits cover every parser-owned buffer. It is not imported by any package.
 */

export const DEFAULT_MAX_PENDING_LINE = 256 * 1024
export const DEFAULT_MAX_EVENT_DATA = 1024 * 1024
export const DEFAULT_MAX_TOTAL_PENDING = 1024 * 1024

const CR = 13
const LF = 10
const SPACE = 32
const TEXT_DECODER_MAX_PENDING_BYTES = 3

export type SseResource = 'pending-line' | 'event-data' | 'total-pending'

export class SseResourceLimitError extends Error {
  readonly code = 'SSE_RESOURCE_LIMIT' as const
  readonly resource: SseResource
  readonly limit: number
  readonly observed: number

  constructor(
    resource: SseResource,
    limit: number,
    observed: number,
  ) {
    super(`SSE ${resource} exceeded limit ${limit} (observed ${observed})`)
    this.name = 'SseResourceLimitError'
    this.resource = resource
    this.limit = limit
    this.observed = observed
  }
}

export class SseParserStateError extends Error {
  readonly code = 'SSE_PARSER_STATE' as const
  readonly state: 'cancelled' | 'failed' | 'finished'

  constructor(state: 'cancelled' | 'failed' | 'finished') {
    super(`Cannot use SSE parser after it was ${state}`)
    this.name = 'SseParserStateError'
    this.state = state
  }
}

export interface OwnedSseEvent {
  id?: string
  event?: string
  data: string
}

export interface OwnedSseParseIssue {
  type: 'invalid-retry' | 'unknown-field'
  field?: string
  value?: string
  line?: string
}

export interface OwnedSseParserOptions {
  maxPendingLine?: number
  maxEventData?: number
  maxTotalPending?: number
  onEvent?: (event: OwnedSseEvent) => void
  onComment?: (comment: string) => void
  onId?: (id: string) => void
  onRetry?: (milliseconds: number) => void
  onError?: (issue: OwnedSseParseIssue) => void
}

export interface OwnedSseParser {
  feed(bytes: Uint8Array): void
  finish(): void
  cancel(): void
}

/** Create a fresh parser for exactly one byte stream. */
export function createOwnedSseParser(options: OwnedSseParserOptions = {}): OwnedSseParser {
  const maxPendingLine = positiveLimit(options.maxPendingLine, DEFAULT_MAX_PENDING_LINE)
  const maxEventData = positiveLimit(options.maxEventData, DEFAULT_MAX_EVENT_DATA)
  const maxTotalPending = positiveLimit(options.maxTotalPending, DEFAULT_MAX_TOTAL_PENDING)
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })

  const lineFragments: string[] = []
  const dataLines: string[] = []
  let lineLength = 0
  let dataLength = 0
  let skipLeadingLf = false
  let id: string | undefined
  let eventType: string | undefined
  let state: 'active' | 'cancelled' | 'failed' | 'finished' = 'active'

  function feed(bytes: Uint8Array): void {
    assertActive()
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('SSE parser input must be a Uint8Array')
    }
    processText(decoder.decode(bytes, { stream: true }))
  }

  function finish(): void {
    assertActive()
    processText(decoder.decode())
    // WHATWG: an event without its terminating blank line is discarded at EOF.
    clearBuffers()
    state = 'finished'
  }

  function cancel(): void {
    if (state !== 'active') return
    clearBuffers()
    state = 'cancelled'
  }

  function processText(text: string): void {
    if (text.length === 0) return

    let start = 0
    if (skipLeadingLf) {
      skipLeadingLf = false
      if (text.charCodeAt(0) === LF) start = 1
    }

    for (let index = start; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code !== CR && code !== LF) continue

      appendLineFragment(text.slice(start, index))
      processLine(joinLine())

      if (code === CR) {
        if (index + 1 < text.length && text.charCodeAt(index + 1) === LF) index++
        else if (index + 1 === text.length) skipLeadingLf = true
      }
      start = index + 1
    }

    appendLineFragment(text.slice(start))
  }

  function appendLineFragment(fragment: string): void {
    if (fragment.length === 0) return
    const observed = lineLength + fragment.length
    if (observed > maxPendingLine) fail('pending-line', maxPendingLine, observed)
    lineFragments.push(fragment)
    lineLength = observed
    checkTotalPending()
  }

  function joinLine(): string {
    if (lineLength === 0) return ''
    const line = lineFragments.length === 1 ? lineFragments[0]! : lineFragments.join('')
    lineFragments.length = 0
    lineLength = 0
    return line
  }

  function processLine(line: string): void {
    if (line.length === 0) {
      dispatchEvent()
      return
    }

    if (line.charCodeAt(0) === 58) {
      const valueStart = line.charCodeAt(1) === SPACE ? 2 : 1
      options.onComment?.(line.slice(valueStart))
      return
    }

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const rawValue = separator === -1 ? '' : line.slice(separator + 1)
    const value = rawValue.charCodeAt(0) === SPACE ? rawValue.slice(1) : rawValue

    switch (field) {
      case 'data':
        appendData(value)
        return
      case 'event':
        eventType = value || undefined
        return
      case 'id':
        if (!value.includes('\0')) id = value
        return
      case 'retry':
        if (/^[0-9]+$/.test(value)) options.onRetry?.(Number.parseInt(value, 10))
        else options.onError?.({ type: 'invalid-retry', value, line })
        return
      default:
        options.onError?.({ type: 'unknown-field', field, value, line })
    }
  }

  function appendData(value: string): void {
    const observed = dataLength + (dataLines.length === 0 ? 0 : 1) + value.length
    if (observed > maxEventData) fail('event-data', maxEventData, observed)
    dataLines.push(value)
    dataLength = observed
    checkTotalPending()
  }

  function dispatchEvent(): void {
    if (id !== undefined) options.onId?.(id)
    if (dataLines.length > 0) {
      const parsedEvent: OwnedSseEvent = { data: dataLines.join('\n') }
      if (id !== undefined) parsedEvent.id = id
      if (eventType !== undefined) parsedEvent.event = eventType
      options.onEvent?.(parsedEvent)
    }
    id = undefined
    eventType = undefined
    dataLines.length = 0
    dataLength = 0
  }

  function checkTotalPending(): void {
    // TextDecoder may retain at most three bytes of one incomplete UTF-8 scalar.
    const observed = lineLength + dataLength + TEXT_DECODER_MAX_PENDING_BYTES
    if (observed > maxTotalPending) fail('total-pending', maxTotalPending, observed)
  }

  function fail(resource: SseResource, limit: number, observed: number): never {
    clearBuffers()
    state = 'failed'
    throw new SseResourceLimitError(resource, limit, observed)
  }

  function clearBuffers(): void {
    lineFragments.length = 0
    dataLines.length = 0
    lineLength = 0
    dataLength = 0
    skipLeadingLf = false
    id = undefined
    eventType = undefined
  }

  function assertActive(): void {
    if (state !== 'active') throw new SseParserStateError(state)
  }

  return { feed, finish, cancel }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError('SSE parser limits must be positive safe integers')
  }
  return resolved
}
