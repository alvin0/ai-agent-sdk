import { applyModelCallUsagePolicy, modelCallPolicyDecision, type UsagePolicyResult } from './ledger-policy.ts'
import {
  OPERATION_EVENT, OPERATION_SPAN, applyReceipt, deliverySummary, errorData, isOperationStatus, ledgerSpanInput,
  ledgerEvent, ledgerLimit, ledgerResource, ledgerSerializedBytes, mergeDelivery, observationMode, openSpan,
  operationCountsOf, resolveLimits, resolveUsagePolicy,
  validateLedgerOptions,
  type DeliveryTracker, type MutableOperation, type ResolvedLimits, type ResolvedUsagePolicy,
} from './ledger-support.ts'
import { AgentSdkError } from '../../errors/index.ts'
import {
  NOOP_OBSERVATION_PORT, OBSERVATION_ERROR_CODES, createObservationRunScope,
  createOperationId, safeErrorRecord,
  validateCaptureReceipt,
  type CorrelationContext, type DeliveryMode, type ModelCallReport, type ModelInvocationContext,
  type ObservationEvent,
  type ObservationEventName, type ObservationPort, type ObservationResource, type ObservationSpan,
  type OperationStatus, type SafeErrorRecord,
} from '../../observation/index.ts'
import { deepFreeze, type JsonObject } from '../../primitives/index.ts'
import { type GenerateOptions } from '../../contract/index.ts'
import { AGENT_ACCOUNTING_ERROR_CODES } from './error.ts'
import type {
  EndRunOperationInput, ModelCallPolicyDecision, RunAccountingPort, StartRunOperationInput,
} from './contracts.ts'
import type {
  LegacyRunReport, RunLedgerLimits, TrackedOperationKind, UsagePolicy,
} from './report.ts'
import { aggregateUsage } from './usage.ts'
import { accountingError } from './common.ts'
import { OPERATION_KINDS } from './config.ts'
import type { SdkLogger } from '../../logging/types.ts'

export interface RunLedgerOptions {
  readonly runId?: string
  readonly observation?: ObservationPort
  readonly resource?: ObservationResource
  readonly parent?: CorrelationContext
  readonly conversationId?: string
  readonly sessionId?: string
  readonly agentId: string
  /** Extra headers/body fields for this agent's provider requests. */
  readonly providerOptions?: {
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: Readonly<Record<string, unknown>>
  }
  readonly mode: string
  readonly maxTurns: number | 'auto'
  readonly usagePolicy?: UsagePolicy
  readonly cumulativeTokenBudget?: boolean
  readonly limits?: RunLedgerLimits
  readonly logger?: (correlation: CorrelationContext) => SdkLogger
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
  private stoppedUsage: ModelCallPolicyDecision | undefined
  get usageStop(): ModelCallPolicyDecision | undefined { return this.stoppedUsage }

  private readonly port: ObservationPort
  private readonly resource: ObservationResource
  private readonly scope = createObservationRunScope()
  private readonly runSpan: ObservationSpan
  private readonly startedAt = new Date().toISOString()
  private readonly startedMonotonic = this.scope.monotonicMs()
  private readonly tracker: DeliveryTracker = { accepted: 0, rejected: 0, pending: 0, reached: 'none' }
  private readonly limits: ResolvedLimits
  private readonly usagePolicy: ResolvedUsagePolicy
  private readonly estimationClosed = new AbortController()
  private readonly cumulativeTokenBudget: boolean
  private readonly defectMode: 'production' | 'test'
  private readonly operations = new Map<string, MutableOperation>()
  private readonly modelCalls = new Map<string, ModelCallReport>()
  private readonly errors: SafeErrorRecord[] = []
  private serializedBytes = 0
  private toolCalls = 0
  private integrityUnknown = false
  private closed = false
  private finalReport: LegacyRunReport | undefined
  private finalizing: Promise<LegacyRunReport> | undefined

  constructor(options: RunLedgerOptions) {
    validateLedgerOptions(options)
    this.runId = options.runId ?? createOperationId()
    if (this.runId.length === 0) throw new TypeError('run ledger runId must be non-empty')
    this.port = options.observation ?? NOOP_OBSERVATION_PORT
    this.resource = ledgerResource(options)
    this.mode = observationMode(this.port, this.tracker)
    this.limits = resolveLimits(options.limits)
    this.usagePolicy = resolveUsagePolicy(options.usagePolicy)
    this.cumulativeTokenBudget = options.cumulativeTokenBudget ?? false
    this.defectMode = options.defectMode ?? 'production'
    this.runSpan = openSpan(this.port, ledgerSpanInput(options, this.runId, {
      startedAt: this.startedAt, monotonicMs: this.startedMonotonic,
    }), this.tracker)
    this.traceId = this.runSpan.correlation.traceId
    const logger = options.logger?.(this.runSpan.correlation)
    this.modelInvocation = Object.freeze({
      observation: this.port,
      agentId: options.agentId,
      correlation: this.runSpan.correlation,
      terminalCheckpointOwner: 'agent-run' as const,
      scope: this.scope,
      ...(logger === undefined ? {} : { logger }),
      ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
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
      if (this.toolCalls >= this.limits.maxToolCalls) ledgerLimit(`run exceeded ${this.limits.maxToolCalls} tool calls`)
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
    const duplicate = this.validateModelCall(report)
    if (duplicate !== undefined) return duplicate
    const policyErrorIndex = this.reserveModelCall(report)
    const incomplete = report.coverage === 'missing' || report.coverage === 'partial'
    return applyModelCallUsagePolicy({
      report, request, incomplete, usagePolicy: this.usagePolicy, runId: this.runId,
      signal: this.estimationClosed.signal, closed: () => this.closed, errors: this.errors, policyErrorIndex,
      finish: result => this.acceptModelCall(report, incomplete, result),
    })
  }

  private acceptModelCall(
    report: ModelCallReport, incomplete: boolean, result: UsagePolicyResult,
  ): ModelCallPolicyDecision {
    const { accepted, usageRequired, closed } = result
    if (closed) return { report, usageRequired: true, usageUnavailable: false }

    // Conservatively charge the added projection including its field names and
    // changed coverage, not just the counter values inside `estimated`.
    if (accepted !== report) this.charge({
      estimated: accepted.estimated, coverage: accepted.coverage, authoritative: false,
    })
    this.modelCalls.set(accepted.modelCallId, accepted)
    const decision = modelCallPolicyDecision({
      accepted, usageRequired, incomplete, usagePolicy: this.usagePolicy,
      cumulativeTokenBudget: this.cumulativeTokenBudget,
    })
    if (decision.usageRequired || decision.usageUnavailable) this.stoppedUsage ??= decision
    return decision
  }

  private reserveModelCall(report: ModelCallReport): number {
    // Reserve identity and retain provider evidence before calling user code.
    this.charge(report)
    this.modelCalls.set(report.modelCallId, report)
    mergeDelivery(this.tracker, report.delivery)
    const policyErrorIndex = this.errors.length
    if (report.error !== undefined) this.errors.push(report.error)
    for (const attempt of report.attempts) if (attempt.error !== undefined) this.errors.push(attempt.error)
    return policyErrorIndex
  }

  private validateModelCall(report: ModelCallReport): ModelCallPolicyDecision | undefined {
    this.assertOpen('model-call usage')
    if (this.modelCalls.has(report.modelCallId)) {
      this.defect(`duplicate model-call terminal '${report.modelCallId}'`)
      const decision = Object.freeze({ report: this.modelCalls.get(report.modelCallId) ?? report,
        usageRequired: true, usageUnavailable: false })
      this.stoppedUsage ??= decision
      return decision
    }
    if (this.modelCalls.size >= this.limits.maxModelCalls) {
      ledgerLimit(`run exceeded ${this.limits.maxModelCalls} logical model calls`)
    }
    if (report.attempts.length > this.limits.maxAttemptsPerCall) {
      ledgerLimit(`model call '${report.modelCallId}' exceeded ${this.limits.maxAttemptsPerCall} attempts`)
    }

    return undefined
  }

  recordError(error: unknown): void {
    this.errors.push(safeErrorRecord(error))
  }

  finalize(status: OperationStatus, completed: boolean, error?: unknown): Promise<LegacyRunReport> {
    if (this.finalReport !== undefined) return Promise.resolve(this.finalReport)
    if (this.finalizing !== undefined) return this.finalizing
    this.finalizing = this.finalizeOnce(status, completed, error)
    return this.finalizing
  }

  private async finalizeOnce(status: OperationStatus, completed: boolean, error?: unknown): Promise<LegacyRunReport> {
    this.closed = true
    this.estimationClosed.abort(new Error('run ledger closed'))
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
    const final = deepFreeze<LegacyRunReport>({
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
    return ledgerEvent(this.scope, this.resource, { name, phase, correlation, data })
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
        ? { eventId: event.eventId, status: 'rejected' as const, durable: false, boundary: 'none' as const,
          reason: 'exporter-unavailable' as const }
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

  private assertOpen(action: string): void {
    if (!this.closed) return
    this.defect(`${action} occurred after run ledger closure`)
    throw new AgentSdkError(`${action} occurred after run ledger closure`,
      AGENT_ACCOUNTING_ERROR_CODES.LEDGER_STATE_INVALID)
  }

  private charge(value: unknown): void {
    let bytes: number
    try {
      bytes = ledgerSerializedBytes(value)
    } catch {
      ledgerLimit('run ledger state could not be represented as JSON')
    }
    if (this.serializedBytes + bytes > this.limits.maxSerializedBytes) {
      ledgerLimit(`run ledger exceeded ${this.limits.maxSerializedBytes} serialized bytes`)
    }
    this.serializedBytes += bytes
  }
}

export { summarizeModelCallUsage, authoritativeTokenUsage, budgetTokenTotal } from './usage.ts'
