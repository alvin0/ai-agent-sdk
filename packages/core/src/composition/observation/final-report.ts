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
  mode: DeliveryMode,
  requiredBoundary: ObservationBoundary,
): RuntimeRunReport {
  try {
    const prior = deliverySummary(previous)
    const acceptedReceipt = terminal.status === 'accepted'
      && (mode === 'operational'
        ? !terminal.durable && terminal.boundary === 'none'
        : terminal.durable && rank(terminal.boundary) >= rank(requiredBoundary))
    const rejectedReceipt = terminal.status !== 'accepted' && !terminal.durable && terminal.boundary === 'none'
    if (prior.mode !== mode || prior.requiredBoundary !== requiredBoundary || terminal.runId !== record.runId
      || (mode === 'operational') !== (requiredBoundary === 'none')
      || (!acceptedReceipt && !rejectedReceipt)) throw new DeliveryDataError()
    const accepted = terminal.status === 'accepted'
    const pending = saturatingCounterAdd(prior.pendingCritical, terminal.delivery?.pendingRequired ?? 0)
    const reached = mode === 'operational' ? prior.reachedBoundary
      : accepted && terminal.durable ? weaker(prior.reachedBoundary, terminal.boundary) : 'none'
    const complete = prior.complete && accepted && pending === 0 && (mode === 'operational' || terminal.durable)
    const summary: ObservationDeliverySummary = Object.freeze({ mode, requiredBoundary,
      reachedBoundary: reached, complete,
      acceptedCritical: saturatingCounterAdd(prior.acceptedCritical, accepted ? 1 : 0),
      rejectedCritical: saturatingCounterAdd(prior.rejectedCritical, accepted ? 0 : 1),
      pendingCritical: pending,
      ...(accepted ? prior.lastFailure === undefined ? {} : { lastFailure: prior.lastFailure } : {
        lastFailure: Object.freeze({ type: 'Error', message: 'Run terminal delivery did not complete',
          code: terminal.reason === 'capacity' ? OBSERVATION_ERROR_CODES.CAPTURE_REJECTED : OBSERVATION_ERROR_CODES.EXPORT_FAILED }),
      }),
    })
    return withTerminalDelivery(record, summary)
  } catch { throw new DeliveryDataError() }
}

function weaker(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  if (left === 'none') return right
  if (right === 'none') return left
  return rank(left) <= rank(right) ? left : right
}
function rank(value: ObservationBoundary): number { return value === 'remote-acknowledged' ? 2 : value === 'local-durable' ? 1 : 0 }
