import type { SupportSafeError } from '@ai-agent-sdk/core/agent'
import type { SdkLogger } from '@ai-agent-sdk/core/observability'
import { beginStdioServerOperation } from '../common/evidence.ts'
import type { ObservedStdioTransport } from './observed-transport.ts'

export interface McpNodeServerCloseReport {
  readonly state: 'closed'
  readonly deadlineReached: boolean
  readonly unsettledRequests: number
  readonly error?: SupportSafeError
}

interface Closeable { close(): Promise<void> }

export function createReportedServerClose(
  handle: Closeable, transport: ObservedStdioTransport, closeTimeoutMs: number,
  logger?: SdkLogger,
): (options?: { readonly signal?: AbortSignal }) => Promise<McpNodeServerCloseReport> {
  let task: Promise<McpNodeServerCloseReport> | undefined
  return options => task ??= performClose(handle, transport, closeTimeoutMs, logger, options?.signal)
}

async function performClose(
  handle: Closeable, transport: ObservedStdioTransport, timeoutMs: number,
  logger: SdkLogger | undefined, signal: AbortSignal | undefined,
): Promise<McpNodeServerCloseReport> {
  const operation = beginStdioServerOperation(logger, 'close'), attempt = operation.attempt(1)
  const close = settle(handle.close())
  const completed = Promise.all([close, transport.whenIdle()]).then(([outcome]) => outcome)
  const boundary = await raceBoundary(completed, timeoutMs, signal)
  let error: SupportSafeError | undefined
  if (boundary.kind === 'timeout') error = supportError(
    'MCP_NODE_SERVER_CLOSE_TIMEOUT', 'Node MCP server cleanup reached its deadline',
  )
  else if (boundary.kind === 'aborted') error = supportError(
    'MCP_NODE_SERVER_CLOSE_ABORTED', 'Node MCP server cleanup wait was aborted',
  )
  else if (boundary.outcome === 'failed') error = supportError(
    'MCP_NODE_SERVER_CLOSE_FAILED', 'Node MCP server cleanup did not complete',
  )
  if (error === undefined) { attempt.success(); operation.success() }
  else if (boundary.kind === 'aborted') { attempt.abort(); operation.abort() }
  else { attempt.fail(error.code); operation.fail(error.code) }
  return Object.freeze({ state: 'closed', deadlineReached: boundary.kind === 'timeout',
    unsettledRequests: transport.activeRequests, ...(error === undefined ? {} : { error }) })
}

async function settle(promise: Promise<void>): Promise<'complete' | 'failed'> {
  try { await promise; return 'complete' } catch { return 'failed' }
}

type Boundary = { readonly kind: 'completed'; readonly outcome: 'complete' | 'failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }

async function raceBoundary(
  completed: Promise<'complete' | 'failed'>, timeoutMs: number, signal?: AbortSignal,
): Promise<Boundary> {
  if (signal?.aborted === true) return { kind: 'aborted' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: () => void = () => {}
  const timeout = new Promise<Boundary>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs) })
  const aborted = signal === undefined ? new Promise<Boundary>(() => {}) : new Promise<Boundary>(resolve => {
    const listener = () => resolve({ kind: 'aborted' })
    signal.addEventListener('abort', listener, { once: true })
    removeAbort = () => signal.removeEventListener('abort', listener)
  })
  try {
    return await Promise.race([completed.then(outcome => ({ kind: 'completed' as const, outcome })), timeout, aborted])
  } finally { if (timer !== undefined) clearTimeout(timer); removeAbort() }
}

function supportError(code: string, message: string): SupportSafeError {
  return Object.freeze({ code, stage: 'mcp-stdio-server-close', message,
    usageCoverage: Object.freeze({ logicalCalls: 0, attempts: 0, complete: 0, partial: 0,
      estimated: 0, missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0 }),
    possiblyBilledAttemptsWithoutUsage: 0 })
}
