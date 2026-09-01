import { deepFreeze } from '../primitives/freeze.ts'

declare const OBSERVATION_ID_BRAND: unique symbol

export type TraceId = string & { readonly [OBSERVATION_ID_BRAND]: 'TraceId' }
export type SpanId = string & { readonly [OBSERVATION_ID_BRAND]: 'SpanId' }

export interface CorrelationContext {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly runId: string
  readonly conversationId?: string
  readonly turnId?: string
  readonly modelCallId?: string
  readonly attemptId?: string
  readonly toolCallId?: string
  readonly providerRequestId?: string
  readonly sessionId?: string
}

/** One synchronous sequence and monotonic clock shared by every event in a run. */
export interface ObservationRunScope {
  nextSequence(): number
  monotonicMs(): number
}

/** Create an isolated run event scope. The first sequence returned is one. */
export function createObservationRunScope(): ObservationRunScope {
  const origin = globalThis.performance?.now() ?? Date.now()
  let next = 1
  return Object.freeze({
    nextSequence(): number {
      if (!Number.isSafeInteger(next) || next < 1) throw new RangeError('observation sequence exhausted')
      return next++
    },
    monotonicMs(): number {
      return Math.max(0, (globalThis.performance?.now() ?? Date.now()) - origin)
    },
  })
}

function randomHex(bytes: number): string {
  while (true) {
    const values = new Uint8Array(bytes)
    globalThis.crypto.getRandomValues(values)
    if (values.some(value => value !== 0)) {
      return [...values].map(value => value.toString(16).padStart(2, '0')).join('')
    }
  }
}

export function createTraceId(): TraceId {
  return randomHex(16) as TraceId
}

export function createSpanId(): SpanId {
  return randomHex(8) as SpanId
}

/** IDs for runs, model calls, attempts, events, and other non-W3C operations. */
export function createOperationId(): string {
  return randomHex(16)
}

export function isTraceId(value: unknown): value is TraceId {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value)
}

export function isSpanId(value: unknown): value is SpanId {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value)
}

export function traceparent(context: Pick<CorrelationContext, 'traceId' | 'spanId'>): string {
  return `00-${context.traceId}-${context.spanId}-01`
}

export function freezeCorrelation(context: CorrelationContext): CorrelationContext {
  return deepFreeze({ ...context })
}
