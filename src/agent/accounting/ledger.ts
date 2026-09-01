import {
  AgentSdkError,
  NOOP_OBSERVATION_PORT,
  OBSERVATION_ERROR_CODES,
  SDK_VERSION,
  addUsageCounters,
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  deepFreeze,
  disabledDeliverySummary,
  hasUsageCounters,
  safeErrorRecord,
  snapshotObservationSpan,
  validateCaptureReceipt,
  validateUsageCounters,
  type CaptureReceipt,
  type CorrelationContext,
  type DeliveryMode,
  type GenerateOptions,
  type JsonObject,
  type ModelCallReport,
  type ModelInvocationContext,
  type ObservationBoundary,
  type ObservationDeliverySummary,
  type ObservationEvent,
  type ObservationEventName,
  type ObservationPort,
  type ObservationResource,
  type ObservationSpan,
  type OperationStatus,
  type SafeErrorRecord,
  type UsageCounters,
} from '@ai-agent-sdk/core'
import { AGENT_ACCOUNTING_ERROR_CODES } from './error.ts'
import type {
  EndRunOperationInput,
  ModelCallPolicyDecision,
  RunAccountingPort,
  StartRunOperationInput,
} from './contracts.ts'
import type {
  RunLedgerLimits,
  RunOperationCounts,
  RunReport,
  RunUsageReport,
  TrackedOperationKind,
  UsagePolicy,
} from './report.ts'
import type { TokenUsage } from '@ai-agent-sdk/core'

const OPERATION_KINDS = [
  'turn', 'model-call', 'provider-attempt', 'tool', 'compaction', 'hook',
  'user-input', 'skill', 'memory', 'credential', 'integration',
] as const satisfies readonly TrackedOperationKind[]

const COUNTER_KEYS = [
  'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens',
] as const satisfies readonly (keyof UsageCounters)[]

const OPERATION_EVENT: Readonly<Record<TrackedOperationKind, ObservationEventName>> = Object.freeze({
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

const OPERATION_SPAN: Readonly<Record<TrackedOperationKind, Parameters<ObservationPort['openSpan']>[0]['name']>> = Object.freeze({
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

interface ResolvedLimits {
  readonly maxModelCalls: number
  readonly maxAttemptsPerCall: number
  readonly maxToolCalls: number
  readonly maxSerializedBytes: number
}

interface DeliveryTracker {
  accepted: number
  rejected: number
  pending: number
  reached: ObservationBoundary
  lastFailure?: SafeErrorRecord
}

interface MutableOperation {
  readonly id: string
  readonly kind: TrackedOperationKind
  readonly span: ObservationSpan
  readonly startedAt: string
  readonly startedMonotonic: number
  readonly data: JsonObject
  status?: OperationStatus
  error?: SafeErrorRecord
}

export interface RunLedgerOptions {
  readonly runId?: string
  readonly observation?: ObservationPort
  readonly resource?: ObservationResource
  readonly parent?: CorrelationContext
  readonly conversationId?: string
  readonly sessionId?: string
  readonly agentId: string
  readonly mode: string
  readonly maxTurns: number
  readonly usagePolicy?: UsagePolicy
  readonly cumulativeTokenBudget?: boolean
  readonly limits?: RunLedgerLimits
  /** Contract tests throw immediately; production records health and finalizes unknown. */
  readonly defectMode?: 'production' | 'test'
}

/** Canonical append-only accounting state for one agent invocation. */
export class RunLedger implements RunAccountingPort {
  readonly runId: string
  readonly traceId: CorrelationContext['traceId']
  readonly modelInvocation: ModelInvocationContext
  readonly mode: DeliveryMode
  terminalAuditFailure = false

  private readonly port: ObservationPort
  private readonly resource: ObservationResource
  private readonly scope = createObservationRunScope()
  private readonly runSpan: ObservationSpan
  private readonly startedAt = new Date().toISOString()
  private readonly startedMonotonic = this.scope.monotonicMs()
  private readonly tracker: DeliveryTracker = { accepted: 0, rejected: 0, pending: 0, reached: 'none' }
  private readonly limits: ResolvedLimits
  private readonly usagePolicy: Required<Pick<UsagePolicy, 'onMissing'>> & Pick<UsagePolicy, 'estimator'>
  private readonly cumulativeTokenBudget: boolean
  private readonly defectMode: 'production' | 'test'
  private readonly operations = new Map<string, MutableOperation>()
  private readonly modelCalls = new Map<string, ModelCallReport>()
  private readonly errors: SafeErrorRecord[] = []
  private serializedBytes = 0
  private toolCalls = 0
  private integrityUnknown = false
  private closed = false
  private finalReport: RunReport | undefined
  private finalizing: Promise<RunReport> | undefined

  constructor(options: RunLedgerOptions) {
    if (typeof options.agentId !== 'string' || options.agentId.trim().length === 0) {
      throw new TypeError('run ledger agentId must be non-empty')
    }
    if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new RangeError('run ledger maxTurns must be a positive safe integer')
    }
    this.runId = options.runId ?? createOperationId()
    if (this.runId.length === 0) throw new TypeError('run ledger runId must be non-empty')
    this.port = options.observation ?? NOOP_OBSERVATION_PORT
    this.resource = deepFreeze(options.resource === undefined
      ? { sdkName: 'ai-agent-sdk', sdkVersion: SDK_VERSION, runtime: 'unknown' }
      : { ...options.resource })
    this.mode = observationMode(this.port, this.tracker)
    this.limits = resolveLimits(options.limits)
    this.usagePolicy = resolveUsagePolicy(options.usagePolicy)
    this.cumulativeTokenBudget = options.cumulativeTokenBudget ?? false
    this.defectMode = options.defectMode ?? 'production'
    this.runSpan = openSpan(this.port, {
      name: 'sdk.agent.run',
      runId: this.runId,
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      correlation: {
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
      startedAt: this.startedAt,
      monotonicMs: this.startedMonotonic,
    }, this.tracker)
    this.traceId = this.runSpan.correlation.traceId
    this.modelInvocation = Object.freeze({
      observation: this.port,
      correlation: this.runSpan.correlation,
      terminalCheckpointOwner: 'agent-run' as const,
      scope: this.scope,
    })
    this.capture(this.event('sdk.agent.run', 'start', this.runSpan.correlation, {
      agentId: options.agentId,
      mode: options.mode,
      maxTurns: options.maxTurns,
    }))
  }

  startOperation(kind: TrackedOperationKind, input: StartRunOperationInput = {}): string {
    this.assertOpen('operation start')
    if (!OPERATION_KINDS.includes(kind)) throw new TypeError(`unknown tracked operation kind '${String(kind)}'`)
    const id = input.operationId ?? createOperationId()
    if (this.operations.has(id)) {
      this.defect(`duplicate ${kind} operation start '${id}'`)
      return id
    }
    if (kind === 'tool') {
      if (this.toolCalls >= this.limits.maxToolCalls) this.limit(`run exceeded ${this.limits.maxToolCalls} tool calls`)
      this.toolCalls++
    }
    const startedAt = new Date().toISOString()
    const startedMonotonic = this.scope.monotonicMs()
    const span = openSpan(this.port, {
      name: OPERATION_SPAN[kind],
      runId: this.runId,
      parent: this.runSpan.correlation,
      correlation: input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId },
      startedAt,
      monotonicMs: startedMonotonic,
    }, this.tracker)
    const data = deepFreeze({ ...(input.data ?? {}) })
    this.charge({ id, kind, data })
    this.operations.set(id, { id, kind, span, startedAt, startedMonotonic, data })
    this.capture(this.event(OPERATION_EVENT[kind], 'start', span.correlation, data))
    return id
  }

  endOperation(operationId: string, status: OperationStatus, input: EndRunOperationInput = {}): void {
    const operation = this.operations.get(operationId)
    if (operation === undefined) {
      this.defect(`orphan operation terminal '${operationId}'`)
      return
    }
    if (operation.status !== undefined) {
      this.defect(`duplicate operation terminal '${operationId}'`)
      operation.status = 'unknown'
      return
    }
    if (!isOperationStatus(status)) throw new TypeError(`invalid operation status '${String(status)}'`)
    const endedAt = new Date().toISOString()
    const endedMonotonic = this.scope.monotonicMs()
    operation.status = status
    if (input.error !== undefined) operation.error = safeErrorRecord(input.error)
    operation.span.end(status, endedAt, endedMonotonic)
    if (operation.error !== undefined) this.errors.push(operation.error)
    const data = deepFreeze({
      ...(input.data ?? {}),
      status,
      durationMs: Math.max(0, endedMonotonic - operation.startedMonotonic),
      ...(operation.error === undefined ? {} : { error: errorData(operation.error) }),
    })
    this.charge(data)
    this.capture(this.event(OPERATION_EVENT[operation.kind], 'end', operation.span.correlation, data))
  }

  async recordModelCall(report: ModelCallReport, request: GenerateOptions): Promise<ModelCallPolicyDecision> {
    this.assertOpen('model-call usage')
    if (this.modelCalls.has(report.modelCallId)) {
      this.defect(`duplicate model-call terminal '${report.modelCallId}'`)
      return { report: this.modelCalls.get(report.modelCallId) ?? report, usageRequired: true, usageUnavailable: false }
    }
    if (this.modelCalls.size >= this.limits.maxModelCalls) {
      this.limit(`run exceeded ${this.limits.maxModelCalls} logical model calls`)
    }
    if (report.attempts.length > this.limits.maxAttemptsPerCall) {
      this.limit(`model call '${report.modelCallId}' exceeded ${this.limits.maxAttemptsPerCall} attempts`)
    }

    let accepted = report
    let usageRequired = false
    const incomplete = report.coverage === 'missing' || report.coverage === 'partial'
    if (incomplete && this.usagePolicy.onMissing === 'estimate') {
      try {
        const estimator = this.usagePolicy.estimator
        if (estimator === undefined) throw new TypeError('estimate usage policy requires an estimator')
        const raw = await estimator.estimate({
          runId: this.runId,
          modelCallId: report.modelCallId,
          provider: report.provider,
          model: report.model,
          request,
          report,
        })
        const validation = validateUsageCounters(raw)
        if (validation.invalidFields.length > 0 || validation.overflow || !hasUsageCounters(validation.reported)) {
          throw new TypeError('usage estimator returned invalid or empty counters')
        }
        const estimated = missingCounters(validation.reported, report.reported)
        if (!hasUsageCounters(estimated)) throw new TypeError('usage estimator did not cover a missing counter')
        accepted = deepFreeze({
          ...report,
          coverage: hasUsageCounters(report.reported) ? 'partial' as const : 'estimated' as const,
          estimated,
          authoritative: false,
        })
      } catch (estimatorError) {
        usageRequired = true
        this.errors.push(accountingError(
          'usage estimation failed after a provider response',
          OBSERVATION_ERROR_CODES.USAGE_REQUIRED,
          estimatorError,
        ))
      }
    } else if (incomplete && this.usagePolicy.onMissing === 'fail') {
      usageRequired = true
      this.errors.push(accountingError(
        'provider usage is required by the configured run policy',
        OBSERVATION_ERROR_CODES.USAGE_REQUIRED,
      ))
    } else if (incomplete && report.error?.code !== OBSERVATION_ERROR_CODES.USAGE_MISSING) {
      this.errors.push(accountingError(
        'model call completed without authoritative provider usage',
        OBSERVATION_ERROR_CODES.USAGE_MISSING,
      ))
    }

    this.charge(accepted)
    this.modelCalls.set(accepted.modelCallId, accepted)
    mergeDelivery(this.tracker, accepted.delivery)
    if (accepted.error !== undefined) this.errors.push(accepted.error)
    for (const attempt of accepted.attempts) if (attempt.error !== undefined) this.errors.push(attempt.error)
    return Object.freeze({
      report: accepted,
      usageRequired,
      usageUnavailable: !usageRequired
        && incomplete
        && this.usagePolicy.onMissing === 'warn'
        && this.cumulativeTokenBudget
        && accepted.possiblyBilledAttemptsWithoutUsage > 0,
    })
  }

  recordError(error: unknown): void {
    this.errors.push(safeErrorRecord(error))
  }

  finalize(status: OperationStatus, completed: boolean, error?: unknown): Promise<RunReport> {
    if (this.finalReport !== undefined) return Promise.resolve(this.finalReport)
    if (this.finalizing !== undefined) return this.finalizing
    this.finalizing = this.finalizeOnce(status, completed, error)
    return this.finalizing
  }

  private async finalizeOnce(status: OperationStatus, completed: boolean, error?: unknown): Promise<RunReport> {
    this.closed = true
    if (error !== undefined) this.errors.push(safeErrorRecord(error))
    this.closeOpenOperations()
    const finalStatus: OperationStatus = this.integrityUnknown ? 'unknown' : status
    const endedAt = new Date().toISOString()
    const endedMonotonic = this.scope.monotonicMs()
    const durationMs = Math.max(0, endedMonotonic - this.startedMonotonic)
    const usage = aggregateUsage([...this.modelCalls.values()], this.errors)
    const operationCounts = operationCountsOf(this.operations.values(), this.modelCalls.values())
    this.runSpan.end(finalStatus, endedAt, endedMonotonic)
    const endEvent = this.event('sdk.agent.run', 'end', this.runSpan.correlation, {
      status: finalStatus,
      durationMs,
      completed,
      usage: usage as unknown as JsonObject,
      operationCounts: operationCounts as unknown as JsonObject,
      errorCount: this.errors.length,
    })
    if (this.mode === 'operational') this.capture(endEvent)
    else await this.checkpoint(endEvent)

    const delivery = deliverySummary(this.port, this.mode, this.tracker)
    const modelCalls = [...this.modelCalls.values()].map(report => deepFreeze({ ...report, delivery }))
    const final = deepFreeze<RunReport>({
      runId: this.runId,
      traceId: this.traceId,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      status: finalStatus,
      usage,
      modelCalls,
      operationCounts,
      errors: Object.freeze([...this.errors]),
      delivery,
    })
    this.finalReport = final
    return final
  }

  private closeOpenOperations(): void {
    for (const operation of this.operations.values()) {
      if (operation.status !== undefined) continue
      this.integrityUnknown = true
      const missing = accountingError(
        `${operation.kind} operation '${operation.id}' closed without a terminal event`,
        OBSERVATION_ERROR_CODES.OPERATION_TERMINAL_MISSING,
      )
      this.errors.push(missing)
      const endedAt = new Date().toISOString()
      const endedMonotonic = this.scope.monotonicMs()
      operation.status = 'unknown'
      operation.error = missing
      operation.span.end('unknown', endedAt, endedMonotonic)
      this.capture(this.event(OPERATION_EVENT[operation.kind], 'end', operation.span.correlation, {
        status: 'unknown',
        durationMs: Math.max(0, endedMonotonic - operation.startedMonotonic),
        error: errorData(missing),
      }))
    }
  }

  private event(
    name: ObservationEventName,
    phase: ObservationEvent['phase'],
    correlation: CorrelationContext,
    data: JsonObject,
  ): ObservationEvent {
    return deepFreeze({
      schemaVersion: 1 as const,
      eventId: createOperationId(),
      sequence: this.scope.nextSequence(),
      name,
      phase,
      occurredAt: new Date().toISOString(),
      monotonicMs: this.scope.monotonicMs(),
      priority: 'critical' as const,
      resource: this.resource,
      correlation,
      data,
    })
  }

  private capture(event: ObservationEvent): void {
    try {
      const receipt = validateCaptureReceipt(this.port.capture(event), event.eventId)
      applyReceipt(this.tracker, receipt)
    } catch (captureError) {
      this.tracker.rejected++
      this.tracker.lastFailure = safeErrorRecord(captureError)
    }
  }

  private async checkpoint(event: ObservationEvent): Promise<void> {
    this.tracker.pending++
    try {
      const raw = this.port.checkpoint === undefined
        ? { eventId: event.eventId, status: 'rejected' as const, durable: false, boundary: 'none' as const, reason: 'exporter-unavailable' as const }
        : await this.port.checkpoint(event)
      this.tracker.pending--
      const receipt = validateCaptureReceipt(raw, event.eventId)
      applyReceipt(this.tracker, receipt)
      if (receipt.status !== 'accepted' || !receipt.durable) {
        this.tracker.lastFailure = accountingError(
          `run terminal checkpoint was ${receipt.status}`,
          OBSERVATION_ERROR_CODES.CAPTURE_REJECTED,
        )
        this.terminalAuditFailure = this.mode === 'audit'
      }
    } catch (checkpointError) {
      this.tracker.pending--
      this.tracker.rejected++
      this.tracker.lastFailure = safeErrorRecord(checkpointError)
      this.terminalAuditFailure = this.mode === 'audit'
    }
  }

  private defect(message: string): void {
    const error = new AgentSdkError(message, AGENT_ACCOUNTING_ERROR_CODES.LEDGER_STATE_INVALID)
    if (this.defectMode === 'test') throw error
    this.integrityUnknown = true
    this.errors.push(safeErrorRecord(error))
    this.capture(this.event('sdk.observer.failure', 'point', this.runSpan.correlation, {
      observerId: 'agent-run-ledger',
      failureKind: 'state-machine',
      counter: this.errors.length,
      error: errorData(safeErrorRecord(error)),
    }))
  }

  private limit(message: string): never {
    throw new AgentSdkError(message, OBSERVATION_ERROR_CODES.LEDGER_LIMIT_EXCEEDED)
  }

  private assertOpen(action: string): void {
    if (!this.closed) return
    this.defect(`${action} occurred after run ledger closure`)
    throw new AgentSdkError(`${action} occurred after run ledger closure`, AGENT_ACCOUNTING_ERROR_CODES.LEDGER_STATE_INVALID)
  }

  private charge(value: unknown): void {
    let bytes: number
    try {
      const encoded = JSON.stringify(value)
      bytes = encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength
    } catch {
      this.limit('run ledger state could not be represented as JSON')
    }
    if (this.serializedBytes + bytes > this.limits.maxSerializedBytes) {
      this.limit(`run ledger exceeded ${this.limits.maxSerializedBytes} serialized bytes`)
    }
    this.serializedBytes += bytes
  }
}

function resolveLimits(input: RunLedgerLimits | undefined): ResolvedLimits {
  return Object.freeze({
    maxModelCalls: positive(input?.maxModelCalls ?? 1_024, 'maxModelCalls'),
    maxAttemptsPerCall: positive(input?.maxAttemptsPerCall ?? 16, 'maxAttemptsPerCall'),
    maxToolCalls: positive(input?.maxToolCalls ?? 10_000, 'maxToolCalls'),
    maxSerializedBytes: positive(input?.maxSerializedBytes ?? 16 * 1024 * 1024, 'maxSerializedBytes'),
  })
}

function resolveUsagePolicy(input: UsagePolicy | undefined): RunLedger['usagePolicy'] {
  const onMissing = input?.onMissing ?? 'warn'
  if (!['warn', 'estimate', 'fail'].includes(onMissing)) throw new TypeError('usage policy onMissing is invalid')
  if (onMissing === 'estimate') {
    if (typeof input?.estimator?.id !== 'string' || input.estimator.id.trim().length === 0
      || typeof input.estimator.estimate !== 'function') {
      throw new TypeError('estimate usage policy requires an estimator with a non-empty id')
    }
  }
  return Object.freeze({ onMissing, ...(input?.estimator === undefined ? {} : { estimator: input.estimator }) })
}

function observationMode(port: ObservationPort, tracker: DeliveryTracker): DeliveryMode {
  try {
    const mode = port.mode
    if (mode === 'operational' || mode === 'reliable' || mode === 'audit') return mode
    throw new TypeError('observation delivery mode is invalid')
  } catch (error) {
    tracker.lastFailure = safeErrorRecord(error)
    return 'operational'
  }
}

function openSpan(
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

function applyReceipt(tracker: DeliveryTracker, receipt: CaptureReceipt): void {
  if (receipt.status === 'accepted') tracker.accepted++
  else tracker.rejected++
  if (receipt.status === 'accepted' && boundaryRank(receipt.boundary) > boundaryRank(tracker.reached)) {
    tracker.reached = receipt.boundary
  }
}

function mergeDelivery(tracker: DeliveryTracker, summary: ObservationDeliverySummary): void {
  tracker.accepted += summary.acceptedCritical
  tracker.rejected += summary.rejectedCritical
  tracker.pending += summary.pendingCritical
  if (boundaryRank(summary.reachedBoundary) > boundaryRank(tracker.reached)) tracker.reached = summary.reachedBoundary
  if (summary.lastFailure !== undefined) tracker.lastFailure = summary.lastFailure
}

function deliverySummary(port: ObservationPort, mode: DeliveryMode, tracker: DeliveryTracker): ObservationDeliverySummary {
  if (port === NOOP_OBSERVATION_PORT) return disabledDeliverySummary()
  const requiredBoundary: ObservationBoundary = mode === 'operational'
    ? 'none'
    : boundaryRank(tracker.reached) > 0 ? tracker.reached : 'local-durable'
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

function aggregateUsage(reports: readonly ModelCallReport[], errors: SafeErrorRecord[]): RunUsageReport {
  const coverage = {
    logicalCalls: reports.length,
    attempts: reports.reduce((total, report) => total + report.attempts.length, 0),
    complete: reports.filter(report => report.coverage === 'complete').length,
    partial: reports.filter(report => report.coverage === 'partial').length,
    estimated: reports.filter(report => report.coverage === 'estimated').length,
    missing: reports.filter(report => report.coverage === 'missing').length,
    notApplicable: reports.filter(report => report.coverage === 'not-applicable').length,
    possiblyBilledAttemptsWithoutUsage: reports.reduce(
      (total, report) => saturating(total, report.possiblyBilledAttemptsWithoutUsage).value,
      0,
    ),
  }
  if (reports.length === 0) {
    return deepFreeze({
      reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      coverage,
      authoritative: true,
    })
  }
  const reported = aggregateCounterSets(reports.map(report => report.reported), errors)
  const estimatedValues = reports.flatMap(report => report.estimated === undefined ? [] : [report.estimated])
  const estimated = estimatedValues.length === 0 ? undefined : aggregateCounterSets(estimatedValues, errors)
  const authoritative = reports.every(report => report.authoritative)
    && !errors.some(error => error.code === OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW
      || error.code === OBSERVATION_ERROR_CODES.USAGE_INVALID)
  return deepFreeze({
    reported,
    ...(estimated === undefined ? {} : { estimated }),
    coverage,
    authoritative,
  })
}

/** Deterministic public projection used by turn outcomes and the canonical ledger. */
export function summarizeModelCallUsage(reports: readonly ModelCallReport[]): RunUsageReport {
  return aggregateUsage(reports, [])
}

/** Legacy exact usage exists only when every logical call is authoritative. */
export function authoritativeTokenUsage(report: RunUsageReport): TokenUsage | undefined {
  if (!report.authoritative) return undefined
  const inputTokens = report.reported.inputTokens
  const outputTokens = report.reported.outputTokens
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return Object.freeze({
    inputTokens,
    outputTokens,
    ...(report.reported.totalTokens === undefined ? {} : { totalTokens: report.reported.totalTokens }),
    ...(report.reported.cacheReadTokens === undefined ? {} : { cacheReadTokens: report.reported.cacheReadTokens }),
    ...(report.reported.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: report.reported.cacheWriteTokens }),
    ...(report.reported.reasoningTokens === undefined ? {} : { reasoningTokens: report.reported.reasoningTokens }),
  })
}

/** Budget projection: reported buckets plus estimates only where reporting is absent. */
export function budgetTokenTotal(report: RunUsageReport): number | undefined {
  if (report.authoritative) return report.reported.totalTokens ?? disjointTotal(report.reported)
  const combined: UsageCounters = Object.freeze({
    ...counterValue(report, 'inputTokens'),
    ...counterValue(report, 'cacheReadTokens'),
    ...counterValue(report, 'cacheWriteTokens'),
    ...counterValue(report, 'outputTokens'),
  })
  const bucketTotal = disjointTotal(combined)
  if (bucketTotal !== undefined) return bucketTotal
  return report.reported.totalTokens ?? report.estimated?.totalTokens
}

function counterValue(
  report: RunUsageReport,
  key: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens',
): Partial<Record<typeof key, number>> {
  const value = report.reported[key] ?? report.estimated?.[key]
  return value === undefined ? {} : { [key]: value }
}

function aggregateCounterSets(values: readonly UsageCounters[], errors: SafeErrorRecord[]): UsageCounters {
  const normalized = values.map(value => {
    if (value.totalTokens !== undefined) return value
    const total = disjointTotal(value)
    return total === undefined ? value : { ...value, totalTokens: total }
  })
  const result = addUsageCounters(normalized)
  if (result.overflow) errors.push(accountingError(
    'usage aggregation saturated at Number.MAX_SAFE_INTEGER',
    OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW,
  ))
  return result.counters
}

function disjointTotal(value: UsageCounters): number | undefined {
  const parts = [value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.outputTokens]
  if (parts.every(part => part === undefined)) return undefined
  let total = 0
  for (const part of parts) total = saturating(total, part ?? 0).value
  return total
}

function missingCounters(estimated: UsageCounters, reported: UsageCounters): UsageCounters {
  const output: Partial<Record<keyof UsageCounters, number>> = {}
  for (const key of COUNTER_KEYS) {
    if (reported[key] === undefined && estimated[key] !== undefined) output[key] = estimated[key]
  }
  return Object.freeze({ ...output })
}

function operationCountsOf(
  operations: Iterable<MutableOperation>,
  modelCalls: Iterable<ModelCallReport>,
): Readonly<Record<TrackedOperationKind, RunOperationCounts>> {
  const counts = Object.fromEntries(OPERATION_KINDS.map(kind => [kind, emptyCounts()])) as Record<TrackedOperationKind, MutableCounts>
  for (const operation of operations) addStatus(counts[operation.kind], operation.status ?? 'unknown')
  for (const report of modelCalls) {
    addStatus(counts['model-call'], report.status)
    for (const attempt of report.attempts) addStatus(counts['provider-attempt'], attempt.status)
  }
  return deepFreeze(Object.fromEntries(OPERATION_KINDS.map(kind => [kind, { ...counts[kind] }])) as Record<TrackedOperationKind, RunOperationCounts>)
}

interface MutableCounts { total: number; success: number; error: number; aborted: number; rejected: number; unknown: number }
function emptyCounts(): MutableCounts { return { total: 0, success: 0, error: 0, aborted: 0, rejected: 0, unknown: 0 } }
function addStatus(counts: MutableCounts, status: OperationStatus): void {
  counts.total++
  counts[status]++
}

function accountingError(message: string, code: string, cause?: unknown): SafeErrorRecord {
  return Object.freeze({
    type: 'AgentAccountingError',
    message,
    code,
    ...(cause === undefined ? {} : { causeTypes: safeErrorRecord(cause).causeTypes ?? [safeErrorRecord(cause).type] }),
  })
}

function errorData(error: SafeErrorRecord): JsonObject {
  return {
    type: error.type,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.causeTypes === undefined ? {} : { causeTypes: [...error.causeTypes] }),
  }
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return value === 'success' || value === 'error' || value === 'aborted' || value === 'rejected' || value === 'unknown'
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

function saturating(left: number, right: number): { value: number; overflow: boolean } {
  const total = left + right
  return !Number.isSafeInteger(total)
    ? { value: Number.MAX_SAFE_INTEGER, overflow: true }
    : { value: total, overflow: false }
}

function boundaryRank(boundary: ObservationBoundary): number {
  return boundary === 'remote-acknowledged' ? 2 : boundary === 'local-durable' ? 1 : 0
}
