/** Helpers the scheduler and nested programs share. Internal to the loop. */
import { detachedFrozen } from '../../primitives/index.ts'
import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolCallPosition, ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError } from '../tool/errors.ts'
import { toolFailure, type prepareToolCall, type ToolInterceptor } from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import type { TraceRef } from '../trace/trace.ts'
import type { History } from '../history/history.ts'
import type { AgentEvent, TurnHooks } from './events.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { SdkLogger } from '../../logging/types.ts'

/** What scheduling shares with its helpers. `RunToolCallsOptions` satisfies it. */
export interface ToolCallHost {
  readonly catalog: ToolCatalog
  readonly history: History
  readonly position: ToolCallPosition
  readonly logger?: SdkLogger
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly emit?: (event: AgentEvent) => Promise<void>
  readonly checkpoint?: TurnHooks['checkpoint']
  readonly accounting?: RunAccountingPort
}

/** Pair the broker wait with its public event and its accounting operation. */
export function withApprovalEvents(
  options: ToolCallHost,
  prepared: ReturnType<typeof prepareToolCall>,
  trace: TraceRef,
): ReturnType<typeof prepareToolCall> {
  let approvalOperation: string | undefined
  return {
    ...prepared,
    options: {
      ...prepared.options,
      onApprovalRequest: async (request: Parameters<NonNullable<typeof prepared.options.onApprovalRequest>>[0]) => {
        approvalOperation = options.accounting?.startOperation('user-input', {
          toolCallId: request.callId,
          data: { action: 'approval', toolName: request.toolName },
        })
        await emitEvent(options, { type: 'approval-request', request, trace })
      },
      ...options.accounting === undefined ? {} : {
        onApprovalSettled: (status: 'success' | 'error' | 'aborted', error?: unknown) => {
          if (approvalOperation !== undefined) {
            options.accounting?.endOperation(approvalOperation, status, error === undefined ? {} : { error })
            approvalOperation = undefined
          }
        },
      },
    },
  }
}

export function immutableResult(result: ToolExecutionResult, maxResultBytes: number): ToolExecutionResult {
  try {
    if (serializedBytes(result) > maxResultBytes) {
      return detachedFrozen(toolFailure(
        `tool result exceeds the ${maxResultBytes}-byte retention limit`,
        TOOL_ERROR_CODES.INVALID_RESULT,
      ))
    }
    const detached = detachedFrozen(result)
    const bytes = serializedBytes(detached)
    if (bytes > maxResultBytes) {
      return detachedFrozen(toolFailure(
        `tool result exceeds the ${maxResultBytes}-byte retention limit`,
        TOOL_ERROR_CODES.INVALID_RESULT,
      ))
    }
    return detached
  } catch (error: unknown) {
    throw ToolError.fatal(
      'tool result could not be detached as lossless structured data',
      TOOL_ERROR_CODES.INVALID_RESULT,
      { cause: error },
    )
  }
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('tool result is not lossless JSON')
  return new TextEncoder().encode(serialized).byteLength
}

export function teardownFailure(
  toolName: string,
  stage: string,
  timeoutMs: number,
  cause: unknown,
): ToolError {
  return ToolError.fatal(
    `tool "${toolName}" ${stage} ignored cancellation for more than ${timeoutMs}ms; `
      + 'the in-process operation may still be running',
    TOOL_ERROR_CODES.TEARDOWN_TIMEOUT,
    { cause },
  )
}

export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  // The owner has already started this promise; observe it even if cancellation won earlier.
  void pending.catch(() => undefined)
  if (signal.aborted) throw signal.reason ?? new Error('tool call aborted')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('tool call aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export async function emitEvent(options: ToolCallHost, event: AgentEvent): Promise<void> {
  await options.emit?.(detachedFrozen(event))
}

export function errorCode(error: unknown): string {
  try {
    const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
    return typeof code === 'string' ? code : TOOL_ERROR_CODES.FAILED
  } catch { return TOOL_ERROR_CODES.FAILED }
}
export function messageOf(error: unknown): string {
  try { return error instanceof Error ? String(error.message) : String(error) }
  catch { return 'tool failed with an unreadable error' }
}
export function now(): string { return new Date().toISOString() }
