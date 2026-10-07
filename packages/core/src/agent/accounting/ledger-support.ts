import { AgentSdkError } from '../../errors/index.ts'
import {
  NOOP_OBSERVATION_PORT, OBSERVATION_ERROR_CODES, createOperationId, createCoreSpan,
  disabledDeliverySummary, safeErrorRecord,
  snapshotObservationSpan,
  type CaptureReceipt, type CorrelationContext, type DeliveryMode, type ModelCallReport, type ModelInvocationContext,
  type ObservationBoundary, type ObservationDeliverySummary, type ObservationEvent, type ObservationEventName, 
  type ObservationPort,
  type ObservationResource, type ObservationSpan, type OperationStatus, type SafeErrorRecord,
} from '../../observation/index.ts'
import { SDK_VERSION, deepFreeze, type JsonObject } from '../../primitives/index.ts'
import type { RunLedgerLimits, RunOperationCounts, TrackedOperationKind, UsagePolicy } from './report.ts'
import type { RunLedgerOptions } from './ledger.ts'
import { OPERATION_KINDS } from './config.ts'

export type ResolvedUsagePolicy = Required<Pick<UsagePolicy, 'onMissing' | 'estimateTimeoutMs'>>
  & Pick<UsagePolicy, 'estimator'>

export const OPERATION_EVENT: Readonly<Record<TrackedOperationKind, ObservationEventName>> = Object.freeze({
  turn: 'sdk.agent.turn',
  'model-call': 'sdk.model.call',
  'provider-attempt': 'sdk.provider.attempt',
  tool: 'sdk.tool.call',
  compaction: 'sdk.compaction',
  hook: 'sdk.hook.call',
  'user-input': 'sdk.user.input.wait',
  skill: 'sdk.skill.operation',
  memory: 'sdk.memory.operation',
  credential: 'sdk.credential.operation',
  integration: 'sdk.integration.request',
})

export const OPERATION_SPAN: Readonly<Record<TrackedOperationKind,
  Parameters<ObservationPort['openSpan']>[0]['name']>> = Object.freeze({
  turn: 'sdk.agent.turn',
  'model-call': 'sdk.model.call',
  'provider-attempt': 'sdk.provider.attempt',
  tool: 'sdk.tool.call',
  compaction: 'sdk.compaction',
  hook: 'sdk.hook.call',
  'user-input': 'sdk.user.input.wait',
  skill: 'sdk.skill.operation',
  memory: 'sdk.memory.operation',
  credential: 'sdk.credential.operation',
  integration: 'sdk.integration.request',
})

export interface ResolvedLimits {
  readonly maxModelCalls: number
  readonly maxAttemptsPerCall: number
  readonly maxToolCalls: number
  readonly maxSerializedBytes: number
}

export interface DeliveryTracker {
  accepted: number
  rejected: number
  pending: number
  reached: ObservationBoundary
  lastFailure?: SafeErrorRecord
}

export interface MutableOperation {
  readonly id: string
  readonly kind: TrackedOperationKind
  readonly span: ObservationSpan
  readonly startedAt: string
  readonly startedMonotonic: number
  readonly data: JsonObject
  status?: OperationStatus
  error?: SafeErrorRecord
}

export function resolveLimits(input: RunLedgerLimits | undefined): ResolvedLimits {
  return Object.freeze({
    maxModelCalls: positive(input?.maxModelCalls ?? 1_024, 'maxModelCalls'),
    maxAttemptsPerCall: positive(input?.maxAttemptsPerCall ?? 16, 'maxAttemptsPerCall'),
    maxToolCalls: positive(input?.maxToolCalls ?? 10_000, 'maxToolCalls'),
    maxSerializedBytes: positive(input?.maxSerializedBytes ?? 16 * 1024 * 1024, 'maxSerializedBytes'),
  })
}

export function resolveUsagePolicy(input: UsagePolicy | undefined): ResolvedUsagePolicy {
  const onMissing = input?.onMissing ?? 'warn'
  if (!['warn', 'estimate', 'fail'].includes(onMissing)) throw new TypeError('usage policy onMissing is invalid')
  if (onMissing === 'estimate') validateEstimator(input)
  const estimateTimeoutMs = positive(input?.estimateTimeoutMs ?? 30_000, 'estimateTimeoutMs')
  if (estimateTimeoutMs > 2_147_483_647) throw new RangeError('estimateTimeoutMs exceeds the timer range')
  return Object.freeze({ onMissing, estimateTimeoutMs,
    ...(input?.estimator === undefined ? {} : { estimator: input.estimator }) })
}

export function observationMode(port: ObservationPort, tracker: DeliveryTracker): DeliveryMode {
  try {
    const mode = port.mode
    if (mode === 'operational' || mode === 'reliable' || mode === 'audit') return mode
    throw new TypeError('observation delivery mode is invalid')
  } catch (error) {
    tracker.lastFailure = safeErrorRecord(error)
    return 'operational'
  }
}

export function openSpan(
  port: ObservationPort,
  input: Parameters<ObservationPort['openSpan']>[0],
  tracker: DeliveryTracker,
): ObservationSpan {
  try {
    const candidate = snapshotObservationSpan(port.openSpan(input))
    if (candidate !== undefined && candidate.correlation.runId === input.runId) return candidate
    throw new TypeError('observation backend returned an invalid run span')
  } catch (error) {
    tracker.lastFailure = safeErrorRecord(error)
    return createCoreSpan(input)
  }
}

export function applyReceipt(tracker: DeliveryTracker, receipt: CaptureReceipt): void {
  if (receipt.status === 'accepted') tracker.accepted++
  else tracker.rejected++
  if (receipt.status === 'accepted' && boundaryRank(receipt.boundary) > boundaryRank(tracker.reached)) {
    tracker.reached = receipt.boundary
  }
}

export function mergeDelivery(tracker: DeliveryTracker, summary: ObservationDeliverySummary): void {
  tracker.accepted += summary.acceptedCritical
  tracker.rejected += summary.rejectedCritical
  tracker.pending += summary.pendingCritical
  if (boundaryRank(summary.reachedBoundary) > boundaryRank(tracker.reached)) tracker.reached = summary.reachedBoundary
  if (summary.lastFailure !== undefined) tracker.lastFailure = summary.lastFailure
}

export function deliverySummary(port: ObservationPort, mode: DeliveryMode,
  tracker: DeliveryTracker): ObservationDeliverySummary {
  if (port === NOOP_OBSERVATION_PORT) return disabledDeliverySummary()
  const requiredBoundary = requiredDeliveryBoundary(mode, tracker.reached)
  return deepFreeze({
    mode,
    requiredBoundary,
    reachedBoundary: tracker.reached,
    complete: tracker.rejected === 0 && tracker.pending === 0
      && boundaryRank(tracker.reached) >= boundaryRank(requiredBoundary),
    acceptedCritical: tracker.accepted,
    rejectedCritical: tracker.rejected,
    pendingCritical: tracker.pending,
    ...(tracker.lastFailure === undefined ? {} : { lastFailure: tracker.lastFailure }),
  })
}

export function operationCountsOf(
  operations: Iterable<MutableOperation>,
  modelCalls: Iterable<ModelCallReport>,
): Readonly<Record<TrackedOperationKind, RunOperationCounts>> {
  const counts = Object.fromEntries(OPERATION_KINDS.map(kind => [kind,
    emptyCounts()])) as Record<TrackedOperationKind, MutableCounts>
  for (const operation of operations) addStatus(counts[operation.kind], operation.status ?? 'unknown')
  for (const report of modelCalls) {
    addStatus(counts['model-call'], report.status)
    for (const attempt of report.attempts) addStatus(counts['provider-attempt'], attempt.status)
  }
  return deepFreeze(Object.fromEntries(OPERATION_KINDS.map(kind => [kind,
    { ...counts[kind] }])) as Record<TrackedOperationKind, RunOperationCounts>)
}

interface MutableCounts {
  total: number; success: number; error: number; aborted: number; rejected: number; unknown: number
}
function emptyCounts(): MutableCounts { return { total: 0, success: 0, error: 0, aborted: 0, rejected: 0, unknown: 0 } }
function addStatus(counts: MutableCounts, status: OperationStatus): void {
  counts.total++
  counts[status]++
}

export function errorData(error: SafeErrorRecord): JsonObject {
  return {
    type: error.type,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.causeTypes === undefined ? {} : { causeTypes: [...error.causeTypes] }),
  }
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return value === 'success' || value === 'error' || value === 'aborted' || value === 'rejected' || value === 'unknown'
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

function boundaryRank(boundary: ObservationBoundary): number {
  if (boundary === 'remote-acknowledged') return 2
  if (boundary === 'local-durable') return 1
  return 0
}

function validateEstimator(input: UsagePolicy | undefined): void {
  if (typeof input?.estimator?.id !== 'string' || input.estimator.id.trim().length === 0
    || typeof input.estimator.estimate !== 'function') {
    throw new TypeError('estimate usage policy requires an estimator with a non-empty id')
  }
}

function requiredDeliveryBoundary(mode: DeliveryMode, reached: ObservationBoundary): ObservationBoundary {
  if (mode === 'operational') return 'none'
  return boundaryRank(reached) > 0 ? reached : 'local-durable'
}

export function validateLedgerOptions(options: RunLedgerOptions): void {
    if (typeof options.agentId !== 'string' || options.agentId.trim().length === 0) {
      throw new TypeError('run ledger agentId must be non-empty')
    }
    if (options.maxTurns !== 'auto' && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) {
      throw new RangeError("run ledger maxTurns must be a positive safe integer or 'auto'")
    }
}

export function ledgerSpanInput(
  options: RunLedgerOptions, runId: string, clock: { startedAt: string; monotonicMs: number },
): Parameters<ObservationPort['openSpan']>[0] {
  return {
      name: 'sdk.agent.run',
      runId,
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      correlation: {
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
      startedAt: clock.startedAt,
      monotonicMs: clock.monotonicMs,
  }
}

export function ledgerLimit(message: string): never {
  throw new AgentSdkError(message, OBSERVATION_ERROR_CODES.LEDGER_LIMIT_EXCEEDED)
}

export function ledgerResource(options: RunLedgerOptions): ObservationResource {
  return deepFreeze(options.resource === undefined
    ? { sdkName: 'ai-agent-sdk', sdkVersion: SDK_VERSION, runtime: 'unknown' }
    : { ...options.resource })
}

export function ledgerSerializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength
}

export function ledgerEvent(
  scope: NonNullable<ModelInvocationContext['scope']>, resource: ObservationResource,
  input: {
    name: ObservationEventName; phase: ObservationEvent['phase']; correlation: CorrelationContext; data: JsonObject
  },
): ObservationEvent {
  const { name, phase, correlation, data } = input
    return deepFreeze({
      schemaVersion: 1 as const,
      eventId: createOperationId(),
      sequence: scope.nextSequence(),
      name,
      phase,
      occurredAt: new Date().toISOString(),
      monotonicMs: scope.monotonicMs(),
      priority: 'critical' as const,
      resource,
      correlation,
      data,
    })
}
