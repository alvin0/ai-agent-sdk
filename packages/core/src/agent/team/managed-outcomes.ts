import type { JsonValue } from '../../primitives/index.ts'
import type { AgentResponse } from '../define/session.ts'
import type { ManagedAgentWorkerStatus, WorkerRuntime } from './managed-types.ts'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asJson(value: unknown): JsonValue { return value as JsonValue }

/** Worker states that will never change again on their own. */
export const SETTLED_WORKER_STATUS: ReadonlySet<ManagedAgentWorkerStatus> =
  new Set<ManagedAgentWorkerStatus>(['completed', 'failed', 'closed'])

/**
 * Reduce one declared write scope to a comparable path.
 *
 * Comparison is by path component, so the shapes that mean the same directory
 * have to arrive spelled the same way: `./app/`, `app`, and `app\` all name
 * `app`, and a worker writing `app/page.tsx` conflicts with one writing `app`.
 */
/**
 * Why a worker's run did not produce an answer, if it did not.
 *
 * A rejected run is obvious; a run that ends on an error reason is not, because
 * it resolves like any other. Both leave the lead with nothing to read, so both
 * are failures as far as the report is concerned.
 * @param response - What the worker's run returned.
 * @returns The failure to report, or undefined when the worker actually answered.
 */
export function failureOf(response: AgentResponse, requireText: boolean): string | undefined {
  const reason = response.outcome.reason
  if (reason.kind === 'error') return reason.failure.message
  if (reason.kind === 'max-tokens') return 'the model stopped at its output limit'
  if (reason.kind === 'usage-unavailable') return 'the provider reported no usage for a billed call'
  if (reason.kind === 'aborted') return 'the run was aborted'
  if (reason.kind === 'budget-exhausted' && !response.outcome.completed) {
    return `the run stopped at its ${reason.budget} limit before completing the task`
  }
  // Tool-only agents may intentionally complete without a textual answer.
  if (requireText && response.text.trim() === '') return 'it produced no answer'
  return undefined
}

/** Detached evidence keeps full reports available without retaining producer sessions or ancestor chains. */
export function recordEvidence(runtime: WorkerRuntime): void {
  runtime.evidence.status = runtime.status
  runtime.evidence.result = runtime.result
  runtime.evidence.error = runtime.error
}
