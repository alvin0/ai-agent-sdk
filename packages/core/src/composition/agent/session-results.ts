import { publicMessage } from './public-message.ts'
import { AgentRunError } from '../../agent/accounting/error.ts'
import type { AgentRunHandle as LegacyRunHandle } from '../../agent/define/session/types.ts'
import { diagnosticErrorCode, ownErrorField } from '../../errors/diagnostic-code.ts'
import type { JsonValue } from '../../primitives/index.ts'
import type { RunReport } from '../exporter/delivery-types.ts'
import type { ToolSourceRunReference } from '../tool-source/types.ts'
import { inheritCapabilityIdentityConflict } from '../identity/error.ts'
import { createRunTerminalRecord } from '../delivery/terminal.ts'
import { finalizeRuntimeRunReport, type RuntimeRunReport } from '../observation/final-report.ts'
import type { RuntimeAgentHost } from './session-host.ts'
import type { RuntimeAgentResponse } from './types.ts'

export async function runtimeReport(
  host: RuntimeAgentHost,
  legacy: Promise<RunReport>,
  sourceSnapshots: Promise<readonly ToolSourceRunReference[]>,
  signal: AbortSignal,
): Promise<RuntimeRunReport> {
  const [previous, sources] = await Promise.all([legacy, sourceSnapshots])
  const record = createRunTerminalRecord(previous, sources)
  const terminal = await host.observation.checkpointTerminal(record, signal)
  return finalizeRuntimeRunReport(
    record,
    previous.delivery,
    terminal,
    {
      mode: host.observation.mode,
      requiredBoundary: host.observation.requiredBoundary,
    },
  )
}

export async function runtimeResult(
  legacy: Promise<Awaited<LegacyRunHandle['result']>>,
  report: Promise<RuntimeRunReport>,
  output: () => JsonValue | undefined,
): Promise<RuntimeAgentResponse> {
  try {
    const response = await legacy
    const final = await report
    const recovered = response.message?.source.kind === 'app'
      && response.message.source.producer === 'terminal-recovery'
    if (final.status !== 'success' && !recovered) {
      throw runtimeFailure(undefined, final, final.errors.at(-1)?.code ?? 'AGENT_RUN_FAILED')
    }
    const parsedOutput = output()
    return Object.freeze({ runId: final.runId, traceId: final.traceId,
      completed: response.outcome.completed, stopReason: response.outcome.reason.kind,
      endReason: response.outcome.reason,
      text: response.text, ...(parsedOutput === undefined ? {} : { output: parsedOutput }),
      ...(response.message === undefined ? {} : { message: publicMessage(response.message) }),
      usage: final.usage, report: final })
  } catch (error) {
    const final = await report
    throw runtimeFailure(error, final, codeOf(error))
  }
}

export function codeOf(value: unknown): string {
  return diagnosticErrorCode(value) ?? 'AGENT_RUN_FAILED'
}
export function diagnosticCause(value: unknown): Error | undefined {
  const code = diagnosticErrorCode(value)
  return code === undefined ? undefined
    : Object.freeze(Object.assign(new Error('Agent operation failed'), { code }))
}
export function runtimeFailure(value: unknown, report: RuntimeRunReport, code: string): AgentRunError {
  const origin = diagnosticErrorCode(value)
  const publicCode = code === 'AGENT_RUN_FAILED' ? origin ?? code : code
  const nested = typeof value === 'object' && value !== null ? ownErrorField(value, 'cause') : undefined
  const cause = diagnosticCause(nested ?? (origin === publicCode ? undefined : value))
  return inheritCapabilityIdentityConflict(
    new AgentRunError('Agent run did not complete', publicCode, report as never,
      cause === undefined ? undefined : { cause }), value,
  )
}
