/** Reading one exporter's row of a batch checkpoint report. Internal to the delivery scheduler. */
import type { ObservationBoundary } from '../../observation/index.ts'
import type { BatchCheckpointReport } from '../delivery/checkpoint.ts'
import type { DeliveryQueueEntry } from './types.ts'

export type ExporterRow = BatchCheckpointReport['exporters'][number]
type RowStatus = ExporterRow['delivery']['status']

/** The exporter answered: it accepted all or part of the batch. */
export function rowDelivered(status: RowStatus): boolean { return status === 'complete' || status === 'partial' }

/** The exporter was called and failed, or did not answer in time. */
export function rowFailed(status: RowStatus): boolean { return status === 'failed' || status === 'timed-out' }

/** A best-effort exporter's final failed attempt settles its items for good. */
export function settlesAsFailed(row: ExporterRow): boolean {
  return row.requirement === 'best-effort'
    && ['failed', 'timed-out', 'aborted', 'closed'].includes(row.delivery.status)
}

export function acceptedEntry(
  entry: DeliveryQueueEntry, events: ReadonlySet<string>, runs: ReadonlySet<string>,
): boolean {
  return entry.kind === 'event' ? events.has(entry.id) : runs.has(entry.id)
}

export function reportStatus(complete: boolean, requiredComplete: boolean,
): 'complete' | 'required-complete' | 'incomplete' {
  if (complete) return 'complete'
  return requiredComplete ? 'required-complete' : 'incomplete'
}

export function weakerBoundary(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  return rank(left) <= rank(right) ? left : right
}
function rank(value: ObservationBoundary): number {
  if (value === 'remote-acknowledged') return 2
  return value === 'local-durable' ? 1 : 0
}
