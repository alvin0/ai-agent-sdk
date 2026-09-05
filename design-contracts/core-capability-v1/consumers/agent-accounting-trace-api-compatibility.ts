import {
  createSpanId,
  createTraceId,
  type GenerateOptions,
  type ModelCallReport,
} from '@ai-agent-sdk/core'
import {
  AGENT_ACCOUNTING_ERROR_CODES,
  AgentRunError,
  authoritativeTokenUsage,
  budgetTokenTotal,
  buildTraceTree,
  summarizeModelCallUsage,
  type AgentProcessSpan,
  type AgentSpanKind,
  type AgentSpanStatus,
  type ModelCallPolicyDecision,
  type RunAccountingPort,
  type RunLedgerLimits,
  type RunOperationCounts,
  type RunReport,
  type RunUsageReport,
  type TraceEvent,
  type TraceRef,
  type TraceSpanEnd,
  type TraceSpanStart,
  type TrackedOperationKind,
  type UsageCoverageSummary,
  type UsageEstimationInput,
  type UsageEstimator,
  type UsagePolicy,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentAccountingTraceApiShape = [
  Assert<Equivalent<AgentSpanKind, 'invoke_agent' | 'chat' | 'execute_tool' | 'compact'>>,
  Assert<Equivalent<AgentSpanStatus, 'success' | 'error' | 'aborted' | 'unknown'>>,
  Assert<Equivalent<UsageEstimationInput['request'], GenerateOptions>>,
  Assert<Equivalent<ModelCallPolicyDecision['report'], ModelCallReport>>,
]

export type AgentAccountingTraceTypeInventory = [
  AgentProcessSpan,
  RunAccountingPort,
  RunLedgerLimits,
  RunOperationCounts,
  RunReport,
  RunUsageReport,
  TraceRef,
  TraceSpanEnd,
  TraceSpanStart,
  TrackedOperationKind,
  UsageCoverageSummary,
  UsageEstimator,
  UsagePolicy,
]

/** Representative deterministic accounting/trace source compiled unchanged on both modules. */
export function exerciseAgentAccountingTraceApi(
  reports: readonly ModelCallReport[],
): readonly AgentProcessSpan[] {
  const traceId = createTraceId()
  const spanId = createSpanId()
  const events: readonly TraceEvent[] = [
    {
      type: 'span-start',
      trace: { traceId, spanId, parentSpanId: null },
      at: '2026-01-01T00:00:00.000Z',
      name: 'agent',
      kind: 'invoke_agent',
    },
    {
      type: 'span-end',
      trace: { traceId, spanId, parentSpanId: null },
      at: '2026-01-01T00:00:01.000Z',
      status: 'success',
    },
  ]
  const usage = summarizeModelCallUsage(reports)
  void authoritativeTokenUsage(usage)
  void budgetTokenTotal(usage)
  void AGENT_ACCOUNTING_ERROR_CODES.RUN_FAILED
  void AgentRunError
  return buildTraceTree(events)
}
