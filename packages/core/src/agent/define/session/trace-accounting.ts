import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { AgentRunEvent } from '../../mode/run-agent.ts'

export function accountTraceEvent(
  accounting: RunAccountingPort,
  spans: Map<string, string>,
  event: AgentRunEvent,
): void {
  if (event.type === 'span-start') {
    accountSpanStart(accounting, spans, event)
    return
  }
  if (event.type === 'span-end') accountSpanEnd(accounting, spans, event)
}

function accountSpanStart(
  accounting: RunAccountingPort,
  spans: Map<string, string>,
  event: Extract<AgentRunEvent, { type: 'span-start' }>,
): void {
  if (event.kind !== 'execute_tool' && event.kind !== 'compact') return
  const kind = event.kind === 'execute_tool' ? 'tool' : 'compaction'
  const toolCallId = typeof event.attributes?.['gen_ai.tool.call.id'] === 'string'
    ? event.attributes['gen_ai.tool.call.id'] : undefined
  const operationId = accounting.startOperation(kind, {
    data: { name: event.name },
    ...toolCallId === undefined ? {} : { toolCallId },
  })
  spans.set(event.trace.spanId, operationId)
}

function accountSpanEnd(
  accounting: RunAccountingPort,
  spans: Map<string, string>,
  event: Extract<AgentRunEvent, { type: 'span-end' }>,
): void {
  const operationId = spans.get(event.trace.spanId)
  if (operationId === undefined) return
  spans.delete(event.trace.spanId)
  accounting.endOperation(operationId, event.status, {
    ...event.error === undefined ? {} : { error: event.error },
  })
}
