import type { GenerateOptions } from '../../contract/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import type { ModelCallReport, ModelInvocationContext, OperationStatus } from '../../observation/index.ts'
import type { LegacyRunReport, TrackedOperationKind } from './report.ts'

export interface ModelCallPolicyDecision {
  readonly report: ModelCallReport
  readonly usageRequired: boolean
  readonly usageUnavailable: boolean
}

export interface StartRunOperationInput {
  readonly operationId?: string
  readonly data?: JsonObject
  readonly toolCallId?: string
}

export interface EndRunOperationInput {
  readonly data?: JsonObject
  readonly error?: unknown
}

/** Inward instrumentation surface consumed by the agent runtime. */
export interface RunAccountingPort {
  readonly runId: string
  readonly traceId: string
  readonly modelInvocation: ModelInvocationContext
  startOperation(kind: TrackedOperationKind, input?: StartRunOperationInput): string
  endOperation(operationId: string, status: OperationStatus, input?: EndRunOperationInput): void
  recordModelCall(report: ModelCallReport, request: GenerateOptions): Promise<ModelCallPolicyDecision>
  recordError(error: unknown): void
  finalize(status: OperationStatus, completed: boolean, error?: unknown): Promise<LegacyRunReport>
}
