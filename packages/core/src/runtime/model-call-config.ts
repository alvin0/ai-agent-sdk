import { ModelCallAttempts } from './model-call-attempts.ts'
import type { StartProviderAttemptInput, ProviderRetryScheduledInput,
  ModelInvocationContext } from '../observation/report.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import type { JsonObject } from '../primitives/json.ts'
import { createOperationId, type CorrelationContext, type ObservationRunScope } from '../observation/context.ts'
import { safeErrorRecord, type ObservationEvent } from '../observation/event.ts'
import { NOOP_OBSERVATION_PORT, validateCaptureReceipt, type DeliveryMode,
  type ObservationPort, type ObservationSpan } from '../observation/port.ts'
import { nowMonotonic, scopeFor, applyReceipt, validParent, openContainedSpan,
  type DeliveryTracker } from './model-call-support.ts'
import type { CreateModelCallHandleOptions } from './model-call-handle.ts'

interface ObservationHost {
  readonly input: CreateModelCallHandleOptions
  readonly scope: ObservationRunScope
  readonly span: ObservationSpan
  readonly port: ObservationPort
  readonly tracker: DeliveryTracker
}

export function captureModelCall(input: CreateModelCallHandleOptions) {
  const contextKey = input.context ?? {}
  const supplied = input.context?.correlation
  const runId = correlationId(supplied, 'runId')
  const modelCallId = correlationId(supplied, 'modelCallId')
  const scope = scopeFor(contextKey, runId, input.context?.scope)
  const startedAt = new Date().toISOString()
  const startedMonotonic = nowMonotonic()
  const port = input.context?.observation ?? input.defaultObservation ?? NOOP_OBSERVATION_PORT
  const tracker: DeliveryTracker = { accepted: 0, rejected: 0, pending: 0, reached: 'none' }
  const mode = observationMode(port, tracker)
  const span = modelCallSpan(port, tracker, { supplied, runId, modelCallId, startedAt, scope })
  const { makeEvent, capture } = observationEvents({ input, scope, span, port, tracker })
  const accounting = new ModelCallAttempts({ input, scope, span, port, tracker, mode, runId, modelCallId, capture })
  const effectiveContext = invocationContext({ input, scope, span, port, accounting })
  capture(makeEvent('start', {
    provider: input.options.provider,
    model: input.options.model,
    operation: 'stream',
  }))

  return { input, runId, modelCallId, scope, startedAt, startedMonotonic, port, tracker, mode, span,
    makeEvent, capture, accounting, effectiveContext }
}

function observationMode(port: ObservationPort, tracker: DeliveryTracker): DeliveryMode {
  let mode: DeliveryMode = 'operational'
  try {
    const configuredMode = port.mode
    if (configuredMode !== 'operational' && configuredMode !== 'reliable' && configuredMode !== 'audit') {
      throw new TypeError('observation delivery mode is invalid')
    }
    mode = configuredMode
  } catch (modeError) {
    tracker.lastFailure = safeErrorRecord(modeError)
  }
  return mode
}

function correlationId(supplied: Partial<CorrelationContext> | undefined, key: 'runId' | 'modelCallId'): string {
  return typeof supplied?.[key] === 'string' && supplied[key].length > 0 ? supplied[key] : createOperationId()
}

function modelCallSpan(port: ObservationPort, tracker: DeliveryTracker, context: {
  readonly supplied: Partial<CorrelationContext> | undefined
  readonly runId: string
  readonly modelCallId: string
  readonly startedAt: string
  readonly scope: ObservationRunScope
}): ObservationSpan {
  const { supplied, runId, modelCallId, startedAt, scope } = context
  const parent = validParent(supplied)
  const span = openContainedSpan(port, {
    name: 'sdk.model.call',
    runId,
    ...(parent === undefined ? {} : { parent }),
    correlation: {
      modelCallId,
      ...supplied?.conversationId === undefined ? {} : { conversationId: supplied.conversationId },
      ...supplied?.turnId === undefined ? {} : { turnId: supplied.turnId },
      ...supplied?.sessionId === undefined ? {} : { sessionId: supplied.sessionId },
    },
    startedAt,
    monotonicMs: scope.monotonicMs(),
  }, tracker)
  return span
}

function observationEvents(host: ObservationHost) {
  const { input, scope, span, port, tracker } = host
  const makeEvent = (phase: 'start' | 'end', data: JsonObject): ObservationEvent<'sdk.model.call'> => deepFreeze({
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: scope.nextSequence(),
    name: 'sdk.model.call',
    phase,
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority: 'critical',
    resource: input.resource,
    correlation: span.correlation,
    data,
  })

  const capture = (event: ObservationEvent): void => {
    try {
      const receipt = validateCaptureReceipt(port.capture(event), event.eventId)
      applyReceipt(tracker, receipt, event.priority === 'critical')
    } catch (error) {
      tracker.rejected += event.priority === 'critical' ? 1 : 0
      tracker.lastFailure = safeErrorRecord(error)
    }
  }

  return { makeEvent, capture }
}

function invocationContext(host: Omit<ObservationHost, 'tracker'> & {
  readonly accounting: ModelCallAttempts
}): ModelInvocationContext {
  const { input, scope, span, port, accounting } = host
  return Object.freeze({
    observation: port,
    resource: input.resource,
    correlation: span.correlation,
    terminalCheckpointOwner: input.context?.terminalCheckpointOwner ?? 'model-call',
    scope,
    ...(input.context?.logger === undefined ? {} : { logger: input.context.logger }),
    ...(input.context?.agentId === undefined ? {} : { agentId: input.context.agentId }),
    ...(input.context?.providerOptions === undefined ? {} : { providerOptions: input.context.providerOptions }),
    declareProviderAttemptAccounting: () => { accounting.declared = true },
    startProviderAttempt: (attempt: StartProviderAttemptInput, signal?: AbortSignal) =>
      accounting.startProviderAttempt(attempt, signal),
    recordProviderRetry: (retry: ProviderRetryScheduledInput) => accounting.recordProviderRetry(retry),
  })
}
