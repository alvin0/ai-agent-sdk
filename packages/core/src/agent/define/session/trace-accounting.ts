import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { AgentRunEvent } from '../../mode/run-agent.ts'

export function accountTraceEvent(
  accounting: RunAccountingPort,
  spans: Map<string, string>,
  event: AgentRunEvent,
): void {
  if (event.type === 'span-start') {
    if (event.kind !== 'execute_tool' && event.kind !== 'compact') return
    const kind = event.kind === 'execute_tool' ? 'tool' : 'compaction'
    const toolCallId = typeof event.attributes?.['gen_ai.tool.call.id'] === 'string'
      ? event.attributes['gen_ai.tool.call.id']
      : undefined
    const operationId = accounting.startOperation(kind, {
      data: { name: event.name },
      ...toolCallId === undefined ? {} : { toolCallId },
    })
    spans.set(event.trace.spanId, operationId)
    return
  }
  if (event.type !== 'span-end') return
  const operationId = spans.get(event.trace.spanId)
  if (operationId === undefined) return
  spans.delete(event.trace.spanId)
  accounting.endOperation(operationId, event.status, {
    ...event.error === undefined ? {} : { error: event.error },
  })
}
