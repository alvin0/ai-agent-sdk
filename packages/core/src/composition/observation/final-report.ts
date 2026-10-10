import {
  OBSERVATION_ERROR_CODES, type DeliveryMode, type ObservationBoundary, type ObservationDeliverySummary,
} from '../../observation/index.ts'
import type { RunReport, RunTerminalRecord } from '../exporter/delivery-types.ts'
import { deliverySummary } from '../delivery/accounting-data.ts'
import { DeliveryDataError } from '../delivery/data.ts'
import { withTerminalDelivery } from '../delivery/terminal.ts'
import type { TerminalCheckpointResult } from './port.ts'
import { saturatingCounterAdd } from '../common/counter.ts'

export type RuntimeRunReport = RunReport

/** Final immutable target-schema projection; the staged record and legacy ledger report stay unchanged. */
export function finalizeRuntimeRunReport(
  record: RunTerminalRecord,
  previous: ObservationDeliverySummary,
  terminal: TerminalCheckpointResult,
  policy: { mode: DeliveryMode; requiredBoundary: ObservationBoundary },
): RuntimeRunReport {
  try {
    const prior = deliverySummary(previous)
    const { mode, requiredBoundary } = policy
    validateTerminal(record, prior, terminal, policy)
    const accepted = terminal.status === 'accepted'
    const pending = saturatingCounterAdd(prior.pendingCritical, terminal.delivery?.pendingRequired ?? 0)
    const reached = reachedBoundary(prior, terminal, mode, accepted)
    const complete = prior.complete && accepted && pending === 0 && (mode === 'operational' || terminal.durable)
    const summary: ObservationDeliverySummary = Object.freeze({ mode, requiredBoundary,
      reachedBoundary: reached, complete,
      acceptedCritical: saturatingCounterAdd(prior.acceptedCritical, accepted ? 1 : 0),
      rejectedCritical: saturatingCounterAdd(prior.rejectedCritical, accepted ? 0 : 1),
      pendingCritical: pending,
      ...lastFailure(prior, terminal, accepted),
    })
    return withTerminalDelivery(record, summary)
  } catch { throw new DeliveryDataError() }
}

function weaker(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  if (left === 'none') return right
  if (right === 'none') return left
  return rank(left) <= rank(right) ? left : right
}
function rank(value: ObservationBoundary): number {
  if (value === 'remote-acknowledged') return 2
  if (value === 'local-durable') return 1
  return 0
}

function validateTerminal(
  record: RunTerminalRecord, prior: ObservationDeliverySummary, terminal: TerminalCheckpointResult,
  policy: { mode: DeliveryMode; requiredBoundary: ObservationBoundary },
): void {
  const { mode, requiredBoundary } = policy
  const acceptedReceipt = validAcceptedReceipt(terminal, policy)
  const rejectedReceipt = terminal.status !== 'accepted' && !terminal.durable && terminal.boundary === 'none'
  if (prior.mode !== mode || prior.requiredBoundary !== requiredBoundary || terminal.runId !== record.runId
    || (mode === 'operational') !== (requiredBoundary === 'none')
    || (!acceptedReceipt && !rejectedReceipt)) throw new DeliveryDataError()
}

function validAcceptedReceipt(
  terminal: TerminalCheckpointResult, policy: { mode: DeliveryMode; requiredBoundary: ObservationBoundary },
): boolean {
  const { mode, requiredBoundary } = policy
  return terminal.status === 'accepted' && (mode === 'operational'
    ? !terminal.durable && terminal.boundary === 'none'
    : terminal.durable && rank(terminal.boundary) >= rank(requiredBoundary))
}

function reachedBoundary(
  prior: ObservationDeliverySummary, terminal: TerminalCheckpointResult, mode: DeliveryMode, accepted: boolean,
): ObservationBoundary {
  if (mode === 'operational') return prior.reachedBoundary
  if (accepted && terminal.durable) return weaker(prior.reachedBoundary, terminal.boundary)
  return 'none'
}

function lastFailure(prior: ObservationDeliverySummary, terminal: TerminalCheckpointResult, accepted: boolean) {
  if (accepted) {
    return prior.lastFailure === undefined ? {} : { lastFailure: prior.lastFailure }
  }
  return { lastFailure: Object.freeze({
    type: 'Error', message: 'Run terminal delivery did not complete',
    code: terminal.reason === 'capacity'
      ? OBSERVATION_ERROR_CODES.CAPTURE_REJECTED : OBSERVATION_ERROR_CODES.EXPORT_FAILED,
  }) }
}
