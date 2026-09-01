import {
  createOperationId,
  isSpanId,
  isTraceId,
  safeErrorRecord,
  type CorrelationContext,
  type JsonObject,
  type ModelInvocationContext,
  type ObservationEvent,
  type ObservationEventName,
  type ObservationSpanName,
} from '@ai-agent-sdk/core'

interface ProviderOperationInput {
  readonly name: Extract<ObservationEventName, 'sdk.credential.operation' | 'sdk.integration.request'>
  readonly spanName: Extract<ObservationSpanName, 'sdk.credential.operation' | 'sdk.integration.request'>
  readonly data: JsonObject
  readonly failureMessage: string
}

const SAFE_OPERATION_ERROR_TYPES = new Set([
  'AbortError',
  'AgentSdkError',
  'CodexRefreshError',
  'Error',
  'ModelError',
  'RangeError',
  'TypeError',
])

const SAFE_OPERATION_ERROR_CODES = new Set([
  'ABORTED',
  'CODEX_AUTH_FAILED',
  'CODEX_AUTH_MALFORMED',
  'CODEX_REAUTH_REQUIRED',
  'CODEX_REFRESH_TRANSIENT',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'TIMEOUT',
])

/** Observe one nested provider operation without exposing its sensitive values. */
async function observeProviderOperation<T>(
  context: ModelInvocationContext | undefined,
  input: ProviderOperationInput,
  task: () => Promise<T>,
): Promise<T> {
  const port = context?.observation
  const parent = context?.correlation
  const resource = context?.resource
  const scope = context?.scope
  if (port === undefined || parent?.runId === undefined || resource === undefined || scope === undefined
    || !isTraceId(parent.traceId) || !isSpanId(parent.spanId)
    || (parent.parentSpanId !== null && !isSpanId(parent.parentSpanId))) {
    return await task()
  }
  const correlationParent = parent as CorrelationContext

  const startedAt = new Date().toISOString()
  let correlation: CorrelationContext = correlationParent
  let span: ReturnType<typeof port.openSpan> | undefined
  try {
    span = port.openSpan({
      name: input.spanName,
      runId: parent.runId,
      parent: correlationParent,
      startedAt,
      monotonicMs: scope.monotonicMs(),
    })
    correlation = span.correlation
  } catch { /* provider work must not fail because an observer is broken */ }

  const capture = (phase: 'start' | 'end', data: JsonObject): void => {
    const event: ObservationEvent = {
      schemaVersion: 1,
      eventId: createOperationId(),
      sequence: scope.nextSequence(),
      name: input.name,
      phase,
      occurredAt: new Date().toISOString(),
      monotonicMs: scope.monotonicMs(),
      priority: 'critical',
      resource,
      correlation,
      data,
    }
    try { port.capture(event) } catch { /* contained; terminal call accounting remains authoritative */ }
  }

  capture('start', input.data)
  try {
    const result = await task()
    const endedAt = new Date().toISOString()
    try { span?.end('success', endedAt, scope.monotonicMs()) } catch { /* contained */ }
    capture('end', { ...input.data, status: 'success' })
    return result
  } catch (error) {
    const endedAt = new Date().toISOString()
    try { span?.end('error', endedAt, scope.monotonicMs()) } catch { /* contained */ }
    const safe = safeErrorRecord(error)
    const type = SAFE_OPERATION_ERROR_TYPES.has(safe.type) ? safe.type : 'Error'
    capture('end', {
      ...input.data,
      status: 'error',
      error: {
        type,
        message: input.failureMessage,
        ...safe.code !== undefined && SAFE_OPERATION_ERROR_CODES.has(safe.code)
          ? { code: safe.code }
          : {},
        ...safe.status === undefined ? {} : { status: safe.status },
        ...safe.retryable === undefined ? {} : { retryable: safe.retryable },
      },
    })
    throw error
  }
}

export function observeCredentialOperation<T>(
  context: ModelInvocationContext | undefined,
  provider: string,
  operation: 'resolve' | 'refresh' | 'login',
  task: () => Promise<T>,
): Promise<T> {
  return observeProviderOperation(context, {
    name: 'sdk.credential.operation',
    spanName: 'sdk.credential.operation',
    data: { provider, operation },
    failureMessage: 'credential operation failed',
  }, task)
}

export function observeModelCatalogOperation<T>(
  context: ModelInvocationContext | undefined,
  provider: string,
  origin: string,
  task: () => Promise<T>,
): Promise<T> {
  return observeProviderOperation(context, {
    name: 'sdk.integration.request',
    spanName: 'sdk.integration.request',
    data: { integration: 'model-catalog', provider, operation: 'discover', origin },
    failureMessage: 'model catalog operation failed',
  }, task)
}
