import type { ManagedAgentWorker, WorkerRuntime } from './managed-types.ts'
import {
  truncate,
} from './managed-report-text.ts'

/** What the dependencies produced, as context for a dependent about to start. */
function failedDependencyReport(runtime: WorkerRuntime, name: string, maxReportBytes: number) {
  const partial = runtime.result?.text
  const payload = partial ? truncate(partial, maxReportBytes) : undefined
  const line = `- worker address '${name}' FAILED: ${runtime.error}`
    + (partial ? '' : '\nResult payload: absent. No result data was returned.')
    + (payload === undefined ? '' : `\nPartial findings (not a completed task): ${payload}`)
  return { line, partial, payload }
}

export function managedDependencyReport(workers: readonly WorkerRuntime[], maxReportBytes: number): string | undefined {
  let hasTruncatedResult = false
  const lines = workers.map((runtime) => {
    const name = runtime.request.name
    if (runtime.error !== undefined) {
      const failure = failedDependencyReport(runtime, name, maxReportBytes)
      hasTruncatedResult ||= failure.payload !== undefined && failure.payload !== failure.partial
      return failure.line
    }
    if (runtime.result === undefined
      && runtime.status === 'closed') return `- worker address '${name}': closed before reporting. `
        + 'Result payload: absent. No result data was returned.'
    const text = runtime.result?.text ?? ''
    const payload = truncate(text, maxReportBytes)
    hasTruncatedResult ||= payload !== text
    return `- worker address '${name}' finished. `
      + `${payload === text ? 'Full' : 'Truncated'} result payload:\n${payload}`
  })
  if (lines.length === 0) return undefined
  return [
    'Dependency result data: worker addresses are routing metadata. '
    + 'Preserve source identifiers supplied in payloads; an absent payload supplies no evidence identifiers.',
    ...lines,
    ...(hasTruncatedResult ? [
      'Read truncated results with read_dependency_result, the original worker address and nextOffset.',
    ] : []),
  ].join('\n')
}

export function managedWorkerView(runtime: WorkerRuntime): ManagedAgentWorker {
  return Object.freeze({
    name: runtime.request.name,
    agentId: runtime.session.definition.id,
    conversationId: runtime.session.conversationId,
    task: runtime.request.task,
    status: runtime.status,
    context: runtime.request.context,
    dependsOn: runtime.request.dependsOn,
    writes: runtime.request.writes,
    ...(runtime.request.role === undefined ? {} : { role: runtime.request.role }),
    ...(runtime.warnings.length === 0 ? {} : { warnings: runtime.warnings }),
    ...(runtime.request.specialty === undefined ? {} : { specialty: runtime.request.specialty }),
    ...(runtime.result === undefined ? {} : { result: runtime.result }),
    ...(runtime.error === undefined ? {} : { error: runtime.error }),
  })
}

