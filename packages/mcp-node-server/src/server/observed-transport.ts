import type {
  JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions,
} from '@modelcontextprotocol/server'
import type { SdkLogger } from '@ai-agent-sdk/core/observability'
import { beginStdioServerOperation, safeChildLogger,
  type EvidenceAttempt, type EvidenceOperation } from '../common/evidence.ts'

interface PendingRequest {
  readonly operation: EvidenceOperation
  readonly attempt: EvidenceAttempt
}

/** Transport decorator that pairs each physical stdio request with its actual response write. */
export class ObservedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  readonly hasPerRequestStream = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly idleWaiters = new Set<() => void>()
  private closing = false

  constructor(private readonly inner: Transport, private readonly logger?: SdkLogger) {
    inner.onclose = () => { this.abortPending(); this.onclose?.() }
    inner.onerror = error => this.onerror?.(error)
    inner.onmessage = (message, extra) => this.receive(message, extra)
  }

  get activeRequests(): number { return this.pending.size }
  get sessionId(): string | undefined { return this.inner.sessionId }
  set sessionId(value: string | undefined) { this.inner.sessionId = value }

  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version) }
  setSupportedProtocolVersions(versions: string[]): void { this.inner.setSupportedProtocolVersions?.(versions) }
  start(): Promise<void> { return this.inner.start() }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const key = responseKey(message)
    try {
      await this.inner.send(message, options)
      if (key !== undefined) this.finish(key, hasError(message) ? 'error' : 'success')
    } catch (error: unknown) {
      if (key !== undefined) this.finish(key, 'error', 'MCP_STDIO_SEND_FAILED')
      throw error
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.abortPending()
    await this.inner.close()
  }

  whenIdle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.add(resolve))
  }

  private receive<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo): void {
    const key = requestKey(message)
    if (key === undefined) { this.onmessage?.(message, extra); return }
    const prior = this.pending.get(key)
    if (prior !== undefined) {
      prior.attempt.fail('MCP_REQUEST_ID_REUSED'); prior.operation.fail('MCP_REQUEST_ID_REUSED')
      this.pending.delete(key)
    }
    const operation = beginStdioServerOperation(
      safeChildLogger(this.logger, 'mcp-server-request'), 'request',
    )
    const attempt = operation.attempt(1)
    this.pending.set(key, { operation, attempt })
    try { this.onmessage?.(message, extra) }
    catch (error: unknown) {
      this.finish(key, 'error', 'MCP_REQUEST_DISPATCH_FAILED')
      throw error
    }
  }

  private finish(key: string, status: 'success' | 'error', code?: string): void {
    const row = this.pending.get(key)
    if (row === undefined) return
    this.pending.delete(key)
    if (status === 'success') { row.attempt.success(); row.operation.success() }
    else { row.attempt.fail(code ?? 'MCP_PROTOCOL_ERROR'); row.operation.fail(code ?? 'MCP_PROTOCOL_ERROR') }
    if (this.pending.size === 0) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  private abortPending(): void {
    if (!this.closing) this.closing = true
    for (const row of this.pending.values()) { row.attempt.abort(); row.operation.abort() }
  }
}

function requestKey(message: JSONRPCMessage): string | undefined {
  const row = message as { readonly id?: unknown; readonly method?: unknown }
  return typeof row.method === 'string' && (typeof row.id === 'string' || typeof row.id === 'number')
    ? `${typeof row.id}:${String(row.id)}` : undefined
}
function responseKey(message: JSONRPCMessage): string | undefined {
  const row = message as { readonly id?: unknown; readonly result?: unknown; readonly error?: unknown }
  return (typeof row.id === 'string' || typeof row.id === 'number') && ('result' in row || 'error' in row)
    ? `${typeof row.id}:${String(row.id)}` : undefined
}
function hasError(message: JSONRPCMessage): boolean { return 'error' in (message as object) }
