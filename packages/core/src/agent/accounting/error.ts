import { AgentSdkError } from '../../errors/index.ts'
import { type TraceId } from '../../observation/index.ts'
import type { RunReport } from './delivery-types.ts'
import { inheritCapabilityIdentityConflict } from '../../errors/capability-identity.ts'

export const AGENT_ACCOUNTING_ERROR_CODES = Object.freeze({
  RUN_FAILED: 'AGENT_RUN_FAILED',
  LEDGER_STATE_INVALID: 'LEDGER_STATE_INVALID',
} as const)

/** A post-run-creation failure with a support-safe, finalized report. */
export class AgentRunError extends AgentSdkError {
  readonly runId: string
  readonly traceId: TraceId
  readonly report: RunReport

  constructor(message: string, code: string, report: RunReport, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AgentRunError'
    this.runId = report.runId
    this.traceId = report.traceId
    this.report = report
    inheritCapabilityIdentityConflict(this, options?.cause)
  }
}
