import type { SdkLogger } from '@ai-agent-sdk/core/observability'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type { McpCloseReport } from './api-types.ts'
import { beginIntegrationOperation, type McpIntegrationFamily } from '../common/integration-operation.ts'
import { mcpSupportError } from '../common/support-error.ts'

export interface McpClosePlan {
  readonly logger?: SdkLogger
  readonly family: McpIntegrationFamily
  readonly timeoutMs: number
  readonly tasks: readonly (() => Promise<unknown>)[]
  readonly signal?: AbortSignal
}

/** Run every cleanup task under one deadline and retain only support-safe outcomes. */
export async function executeMcpClosePlan(plan: McpClosePlan): Promise<McpCloseReport> {
  const operation = beginIntegrationOperation(plan.logger, plan.family, 'close')
  const attempt = operation.attempt(1)
  const states: ('pending' | 'succeeded' | 'failed')[] = plan.tasks.map(() => 'pending')
  const tasks = plan.tasks.map(async (task, index) => {
    try {
      await Promise.resolve().then(task)
      states[index] = 'succeeded'
    } catch {
      states[index] = 'failed'
    }
  })
  let aborted = plan.signal?.aborted === true
  let removeAbort = (): void => undefined
  const abortObserved = plan.signal === undefined
    ? new Promise<never>(() => undefined)
    : new Promise<void>(resolve => {
      const observe = () => { aborted = true; resolve() }
      plan.signal?.addEventListener('abort', observe, { once: true })
      removeAbort = () => plan.signal?.removeEventListener('abort', observe)
      if (plan.signal?.aborted === true) observe()
    })
  await Promise.race([
    waitForSettlement(Promise.all(tasks), plan.timeoutMs),
    abortObserved,
  ])
  removeAbort()
  const unsettledOperations = states.filter(state => state === 'pending').length
  const failed = states.includes('failed')
  const error = aborted && unsettledOperations > 0
    ? mcpSupportError('MCP_CLOSE_ABORTED', 'mcp-close', 'MCP cleanup was interrupted before it settled')
    : unsettledOperations > 0
    ? mcpSupportError('MCP_CLOSE_TIMEOUT', 'mcp-close', 'MCP cleanup did not settle before its deadline')
    : failed
      ? mcpSupportError('MCP_CLOSE_FAILED', 'mcp-close', 'MCP cleanup failed')
      : undefined
  if (error === undefined) {
    attempt.success()
    operation.success()
  } else {
    attempt.fail(error.code)
    operation.fail(error.code)
  }
  return Object.freeze({
    state: 'closed',
    deadlineReached: !aborted && unsettledOperations > 0,
    unsettledOperations,
    ...(error === undefined ? {} : { error }),
  })
}
