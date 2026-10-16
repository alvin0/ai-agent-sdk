/** One UTF-8 budget for all batch evidence, including escaping and worker diagnostics. */
import type { BatchWorkerView } from './managed-batch-spawn.ts'
import { modelResults } from './team-results.ts'
import type { BatchCoverage } from './managed-batch-coverage.ts'

export const BATCH_PAYLOAD_BYTES = 48 * 1024
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

export function batchPayload(workers: readonly BatchWorkerView[], coverage: BatchCoverage,
  results = modelResults([]),
  { guidance, ...flags }: { timed_out?: boolean; interrupted?: boolean; cancelled?: boolean;
    guidance?: string | undefined } = {},
) {
  const metadata = workers.map(({ target, status }) => ({ target, status }))
  const payload: { workers: BatchWorkerView[]; coverage: BatchCoverage; results: typeof results;
    omitted: string[]; guidance?: string | undefined } = {
    workers: metadata, coverage, ...flags, ...guidance === undefined ? {} : { guidance },
    results: [], omitted: workers.map(worker => worker.target),
  }
  // Reserve every possible omission address up front. Account each field once, rather than
  // repeatedly serializing a potentially large payload while dropping evidence.
  let remaining = BATCH_PAYLOAD_BYTES - byteLength(payload)
  const omitted = new Set<string>()
  workers.forEach((worker, index) => {
    const cost = byteLength(worker) - byteLength(metadata[index])
    if (cost <= remaining) { payload.workers[index] = worker; remaining -= cost }
    else omitted.add(worker.target)
  })
  for (const result of results) {
    const cost = byteLength(result) + (payload.results.length > 0 ? 1 : 0)
    if (cost <= remaining) { payload.results.push(result); remaining -= cost }
    else omitted.add(result.target)
  }
  payload.omitted = [...omitted]
  return payload
}

/** Mandatory addresses/coverage must themselves fit, before any worker starts. */
export function assertBatchMetadataBudget(
  targets: readonly string[], ids: readonly string[], guidance?: string,
): void {
  const worst = { workers: targets.map(target => ({ target, status: 'cancelled' })),
    coverage: { completed: 0, failed: ids, pending: ids, deficit: ids },
    results: [], omitted: targets, guidance, timed_out: false, interrupted: true, cancelled: true }
  if (byteLength(worst) > BATCH_PAYLOAD_BYTES) {
    throw new TypeError('batch addresses and item ids exceed the 48 KiB payload budget; shorten ids or split the batch')
  }
}
