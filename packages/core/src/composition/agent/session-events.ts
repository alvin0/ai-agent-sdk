import type { AgentRunHandle as LegacyRunHandle } from '../../agent/define/session/types.ts'
import type { AgentRunEvent } from '../../agent/mode/run-agent.ts'
import type { ToolExecutionResult } from '../../agent/tool/definition.ts'
import { TOOL_ERROR_CODES } from '../../agent/tool/errors.ts'
import type { RuntimeRunReport } from '../observation/final-report.ts'
import { publicMessage } from './public-message.ts'
import { projectNativeToolEvent } from './native-event.ts'
import type { RuntimeAgentResponse, RuntimeAgentRunEvent, RuntimeAgentRunHandle } from './types.ts'

export function runtimeHandle(
  source: LegacyRunHandle & { readonly traceId: string; abort(reason?: unknown): void },
  report: Promise<RuntimeRunReport>, result: Promise<RuntimeAgentResponse>,
  options: { readonly nativeProvider: string; readonly includeTraceEvents: boolean },
): RuntimeAgentRunHandle {
  let iterated = false
  return Object.freeze({ runId: source.runId, report, result, abort: () => source.abort(),
    [Symbol.asyncIterator](): AsyncIterator<RuntimeAgentRunEvent> {
      if (iterated) return (async function* () { throw new Error('A runtime run handle can only be iterated once') })()
      iterated = true
      return projectEvents(source, report, options.nativeProvider, options.includeTraceEvents)
    } })
}

async function* projectEvents(
  source: LegacyRunHandle & { readonly traceId: string; abort(reason?: unknown): void },
  report: Promise<RuntimeRunReport>,
  nativeProvider: string,
  includeTraceEvents: boolean,
): AsyncGenerator<RuntimeAgentRunEvent> {
  let sequence = 0, completed = false
  const context = () => ({ runId: source.runId, traceId: source.traceId, sequence: ++sequence,
    schemaVersion: 1 as const })
  try {
    for await (const event of source) {
      const projected = projectEvent(event, nativeProvider, includeTraceEvents)
      if (projected !== undefined) yield Object.freeze({ ...context(), ...projected }) as RuntimeAgentRunEvent
    }
    const terminal = await report
    if (terminal.status === 'success') {
      yield Object.freeze({ ...context(), type: 'usage', usage: terminal.usage, report: terminal })
    } else {
      const error = terminal.errors.at(-1) ?? fallbackError(terminal)
      yield Object.freeze({ ...context(), type: 'error', error, report: terminal })
    }
    completed = true
  } catch {
    const terminal = await report
    const error = terminal.errors.at(-1) ?? fallbackError(terminal)
    yield Object.freeze({ ...context(), type: 'error', error, report: terminal })
    completed = true
  } finally { if (!completed) source.abort() }
}

type WithoutEventContext<T> = T extends unknown ? Omit<T, 'runId' | 'traceId' | 'sequence' | 'schemaVersion'> : never
type ProjectedEvent = WithoutEventContext<RuntimeAgentRunEvent>

function projectEvent(event: AgentRunEvent, nativeProvider: string,
  includeTraceEvents: boolean): ProjectedEvent | undefined {
  if (event.type === 'usage-progress') return { type: 'usage-progress', usage: event.usage,
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }) }
  // Runtime consumers such as Edge hosts may persist an execution trace. Keep
  // the SDK's span lifecycle intact; unlike transcript events, spans carry the
  // identity and nesting needed to reconstruct the call tree.
  if (includeTraceEvents && (event.type === 'span-start' || event.type === 'span-end')) return event
  const transcript = projectTranscriptEvent(event)
  if (transcript !== undefined) return transcript
  const lifecycle = projectLifecycleEvent(event)
  if (lifecycle !== undefined) return lifecycle
  return projectInteractionEvent(event, nativeProvider)
}

function projectTranscriptEvent(event: AgentRunEvent): ProjectedEvent | undefined {
  if (event.type === 'text-delta') return {
    type: event.phase === 'commentary' ? 'commentary-delta' : 'assistant-delta',
    text: event.text, index: event.index, phase: event.phase, blockId: `${event.trace.spanId}:${event.index}`,
  }
  if (event.type === 'assistant-message') return { type: 'assistant-message', message: publicMessage(event.message) }
  if (event.type === 'assistant-replacement') return { ...event, message: publicMessage(event.message) }
  if (event.type === 'text-end' || event.type === 'reasoning-delta') {
    const { trace, ...content } = event
    return { ...content, blockId: `${trace.spanId}:${event.index}` }
  }
  if (event.type === 'image-delta') {
    const { trace, ...content } = event
    return { ...content, blockId: `${trace.spanId}:${event.itemId}` }
  }
  return undefined
}

function projectLifecycleEvent(event: AgentRunEvent): ProjectedEvent | undefined {
  if (event.type === 'compaction-start' || event.type === 'compaction-end'
    || event.type === 'turn-start' || event.type === 'step-start' || event.type === 'step-end'
    || event.type === 'assistant-text' || event.type === 'assistant-reasoning') {
    const { trace: _trace, ...content } = event
    return content
  }
  return undefined
}

function projectInteractionEvent(event: AgentRunEvent, nativeProvider: string): ProjectedEvent | undefined {
  if (event.type === 'tool-call') return { type: 'tool-call', callId: event.call.callId,
    name: event.call.toolName, input: parseInput(event.call.rawArguments) }
  if (event.type === 'tool-result') return { type: 'tool-result', callId: event.call.callId,
    name: event.call.toolName, status: toolResultStatus(event.result), output: event.result }
  if (event.type === 'assistant-native-tool') return projectNativeToolEvent(event.call, nativeProvider)
  if (event.type === 'approval-request') return { type: 'approval-request', request: event.request }
  if (event.type === 'user-input-request') return { type: 'user-input-request', request: event.request }
  if (event.type === 'user-input-response') return { type: 'user-input-response', requestId: event.request.requestId,
    response: event.response }
  return undefined
}

function toolResultStatus(
  result: ToolExecutionResult,
): 'completed' | 'failed' | 'aborted' | 'rejected' | 'declined' {
  // A call the loop refused to run is neither success nor failure: nothing
  // broke, and nothing was done. Reporting it as either misleads a UI — and a
  // red row for a budget decision is what makes a finished run look crashed.
  if (!result.isError) return result.meta?.['declined'] === true ? 'declined' : 'completed'
  if (result.error.code === TOOL_ERROR_CODES.ABORTED
    || result.error.code === TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH) return 'aborted'
  if (rejectedToolResult(result)) return 'rejected'
  return 'failed'
}

function parseInput(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return value } }

function rejectedToolResult(result: Extract<ToolExecutionResult, { readonly isError: true }>): boolean {
  return result.error.code === TOOL_ERROR_CODES.UNKNOWN_TOOL
    || result.error.code === TOOL_ERROR_CODES.INVALID_ARGUMENTS
    || result.error.code === TOOL_ERROR_CODES.MALFORMED_ARGUMENTS
    || result.error.code === TOOL_ERROR_CODES.DENIED
    || result.error.code === TOOL_ERROR_CODES.BUDGET_EXHAUSTED
    || result.error.code === TOOL_ERROR_CODES.CHECKPOINT_FAILED
}

function fallbackError(report: RuntimeRunReport): RuntimeRunReport['errors'][number] {
  return Object.freeze({ code: 'AGENT_RUN_FAILED', stage: 'agent-run', message: 'Agent operation failed',
    usageCoverage: report.usage.coverage,
    possiblyBilledAttemptsWithoutUsage: report.usage.coverage.possiblyBilledAttemptsWithoutUsage })
}
