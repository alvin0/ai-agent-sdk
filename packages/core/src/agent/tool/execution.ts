import { isJsonValue, detachedFrozen, type JsonObject } from '../../primitives/index.ts'
import type { ToolExecutionResult } from './definition.ts'
import { ToolError } from './errors.ts'
import type { ToolCallContext, ToolInterceptor } from './pipeline.ts'

/** Claims describe what a backend actually enforces, not permissions granted by policy. */
export interface ToolExecutionCapabilities {
  readonly cancellation: 'cooperative' | 'forced'
  readonly filesystem: 'host' | 'restricted' | 'none'
  readonly network: 'host' | 'restricted' | 'none'
  readonly cleanup: 'best-effort' | 'guaranteed'
}
export interface ToolExecutionRequest {
  readonly operationId: string
  readonly toolName: string
  readonly args: unknown
  /** Trusted host identity; never sourced from model arguments. */
  readonly identity: JsonObject
  readonly signal: AbortSignal
}
export interface ToolExecutionBackend {
  readonly id: string
  readonly capabilities: ToolExecutionCapabilities
  execute(request: ToolExecutionRequest, local: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
}
export const localToolExecutionBackend: ToolExecutionBackend = Object.freeze({
  id: 'local',
  capabilities: Object.freeze({ cancellation: 'cooperative', filesystem: 'host', network: 'host', cleanup: 'best-effort' }),
  execute: (_request: ToolExecutionRequest, local: () => Promise<ToolExecutionResult>) => local(),
})

export interface ToolOperation {
  readonly operationId: string
  readonly toolName: string
  readonly args: unknown
  readonly identity: JsonObject
}
export type ToolOperationClaim =
  | { readonly status: 'claimed' }
  | { readonly status: 'completed'; readonly operation: ToolOperation; readonly result: ToolExecutionResult }
  | { readonly status: 'unknown'; readonly operation: ToolOperation }

/** Separate from conversation memory. The host adapter must durably and atomically claim an ID.
 * An existing in-progress claim is unknown after restart, never implicitly retryable.
 * complete must persist before resolving. Reconciliation is host-owned. */
export interface ToolExecutionStore {
  claim(operation: ToolOperation, signal: AbortSignal): Promise<ToolOperationClaim>
  complete(operation: ToolOperation, result: ToolExecutionResult, signal: AbortSignal): Promise<void>
}

/** Attach via session.interceptors. Policy and approval still run before this adapter,
 * and post-policy still sanitizes both fresh and recovered results. No automatic retry. */
export function createToolExecutionInterceptor(options: {
  readonly backend?: ToolExecutionBackend
  readonly identity: JsonObject
  /** Stable across recovery, scoped to tenant/session by the authenticated host. */
  readonly operationId: (call: ToolCallContext) => string
  readonly store?: ToolExecutionStore
}): ToolInterceptor {
  const backend = options.backend ?? localToolExecutionBackend
  const execute = backend.execute.bind(backend)
  const identity = detachedFrozen(options.identity)
  const operationId = options.operationId
  const store = options.store
  const claim = store?.claim.bind(store), complete = store?.complete.bind(store)
  return Object.freeze({
    name: `execution:${backend.id}`,
    around: async (call: ToolCallContext, local: () => Promise<ToolExecutionResult>) => {
      const id = operationId(call)
      if (typeof id !== 'string' || id.length === 0 || id.length > 512) throw ToolError.fatal('invalid operation identity', 'INVALID_OPERATION_ID')
      const operation = detachedFrozen({ operationId: id, toolName: call.toolName, args: call.args, identity })
      if (call.signal.aborted) throw ToolError.fatal('execution cancelled', 'TOOL_ABORTED')
      if (claim !== undefined) {
        if (!isJsonValue(operation.args) || !isJsonValue(operation.identity)) throw ToolError.fatal('durable operation input must be lossless JSON', 'INVALID_OPERATION_INPUT')
        const previous = await claim(operation, call.signal)
        if (previous.status !== 'claimed') {
          if (canonical(previous.operation) !== canonical(operation)) throw ToolError.fatal('operation identity conflicts with saved input', 'OPERATION_ID_CONFLICT')
          if (previous.status === 'unknown') throw ToolError.fatal('operation outcome is unknown; reconcile before retrying', 'OPERATION_OUTCOME_UNKNOWN')
          return detachedFrozen(previous.result)
        }
      }
      if (call.signal.aborted) throw ToolError.fatal('execution cancelled after claim; reconcile operation', 'OPERATION_OUTCOME_UNKNOWN')
      // A throw, cancellation, or failed completion write leaves the durable claim
      // unresolved. A subsequent attempt must reconcile; it cannot execute again.
      const result = await execute({ ...operation, signal: call.signal }, local)
      await complete?.(operation, result, call.signal)
      return result
    },
  })
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
