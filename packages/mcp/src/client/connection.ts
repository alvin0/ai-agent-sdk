import type { McpConnectionHost, PendingHttpAuthorization } from './connection-host.ts'
import { connectGeneration } from './connection-startup.ts'
import { enqueueToolSync, clearTools } from './connection-catalog.ts'
/** MCP client lifecycle and remote-tool bridge for Universal runtimes. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  ToolRegistry,
  type ToolCatalog,
  type ToolCatalogSnapshot,
  type ToolDefinition,
  type ToolSource,
  type ToolSourceSnapshotOptions,
} from '@alvin0/ai-agent-sdk-core/tools'
import type { McpProtocolClient } from './public-types.ts'
import type {
  McpAuthenticationKind,
  McpAuthorizationState,
  McpClientLifecycleOptions,
  McpClientRuntimeOptions,
  McpClientState,
  McpClientStatus,
  McpCloseReport,
  McpOAuthCallbackOptions,
  McpProtocolState,
  McpTransportFactory,
  ResolvedMcpReconnectOptions,
} from './api-types.ts'
import {
  beginIntegrationOperation,
  integrationErrorCode,
  type McpIntegrationFamily,
} from '../common/integration-operation.ts'
import { executeMcpClosePlan } from './close.ts'
import { mcpSupportError } from '../common/support-error.ts'
import { MCP_CLIENT_DEFAULTS } from './config.ts'
import {
  McpOperationTimeoutError,
  assertServerName,
  errorOf,
  positiveSafeInteger,
  timeoutMilliseconds,
  resolveMcpReconnectOptions,
  snapshotToolFilter,
  snapshotLifecycleOptions,
  withAbortTimeout,
} from './runtime-helpers.ts'

export type * from './public-types.ts'
export type * from './api-types.ts'

/**
 * Owns one MCP server connection across transport generations.
 *
 * The ToolCatalog object is stable for the lifetime of this connection. A
 * successful list refresh swaps its registrations synchronously; a failed
 * refresh leaves the last-known-good catalog intact.
 */
export class McpClientConnection implements ToolSource {
  readonly kind = 'tool-source' as const
  readonly apiVersion = 1 as const
  readonly id: string
  readonly serverName: string
  readonly tools: ToolCatalog

  private readonly options: McpClientLifecycleOptions
  private readonly transportFactory: McpTransportFactory
  private readonly fallbackTransportFactory: McpTransportFactory | undefined
  private readonly authenticationKind: McpAuthenticationKind
  private readonly integrationFamily: McpIntegrationFamily
  private readonly toolCallTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly maxTools: number
  private readonly maxCatalogBytes: number
  private readonly maxToolResultBytes: number
  private readonly reconnect: ResolvedMcpReconnectOptions
  private readonly registry = new ToolRegistry()
  private toolDisposers: (() => void)[] = []
  private current: Client | undefined
  private pendingAuthorization: PendingHttpAuthorization | undefined
  private connecting: Promise<void> | undefined
  private syncTail: Promise<void> = Promise.resolve()
  private pendingToolSyncs = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private catalogRevision = 0
  private connectedAt: number | undefined
  private closed = false
  private closeTask: Promise<McpCloseReport> | undefined
  private currentState: McpClientState

  constructor(
    options: McpClientLifecycleOptions,
    transportFactory: McpTransportFactory,
    runtime: McpClientRuntimeOptions = {},
  ) {
    assertServerName(options.serverName)
    this.toolCallTimeoutMs = timeoutMilliseconds(
      options.toolCallTimeoutMs ?? MCP_CLIENT_DEFAULTS.toolCallTimeoutMs, 'toolCallTimeoutMs',
    )
    this.operationTimeoutMs = timeoutMilliseconds(
      options.operationTimeoutMs ?? MCP_CLIENT_DEFAULTS.operationTimeoutMs, 'operationTimeoutMs',
    )
    this.closeTimeoutMs = timeoutMilliseconds(
      options.closeTimeoutMs ?? MCP_CLIENT_DEFAULTS.closeTimeoutMs, 'closeTimeoutMs',
    )
    this.maxTools = positiveSafeInteger(options.maxTools ?? MCP_CLIENT_DEFAULTS.maxTools, 'maxTools')
    this.maxCatalogBytes = positiveSafeInteger(
      options.maxCatalogBytes ?? MCP_CLIENT_DEFAULTS.maxCatalogBytes, 'maxCatalogBytes',
    )
    this.maxToolResultBytes = positiveSafeInteger(
      options.maxToolResultBytes ?? MCP_CLIENT_DEFAULTS.maxToolResultBytes, 'maxToolResultBytes',
    )
    const toolFilter = snapshotToolFilter(options.toolFilter)
    this.reconnect = resolveMcpReconnectOptions(options.reconnect)
    this.options = snapshotLifecycleOptions(options, toolFilter)
    this.transportFactory = transportFactory
    this.fallbackTransportFactory = runtime.fallbackTransportFactory
    this.authenticationKind = runtime.authenticationKind ?? 'unknown'
    this.integrationFamily = runtime.integrationFamily ?? 'mcp-http-client'
    this.serverName = options.serverName
    this.id = options.serverName
    this.tools = this.registry
    this.currentState = Object.freeze({
      status: 'idle', serverName: options.serverName, attempt: 0, catalogRevision: 0,
    })
  }

  get state(): McpClientState { return this.currentState }

  snapshot(options: ToolSourceSnapshotOptions): ToolCatalogSnapshot {
    options.signal.throwIfAborted()
    return Object.freeze({
      revision: String(this.catalogRevision),
      tools: Object.freeze(this.registry.names().map(name => this.registry.get(name) as ToolDefinition)),
    })
  }

  /**
   * Use the currently owned protocol client for resources, prompts, or other
   * MCP operations that do not map to the SDK ToolCatalog.
   */
  async withClient<T>(operation: (client: McpProtocolClient, signal: AbortSignal) => Promise<T>): Promise<T>
  async withClient<TClient, T>(operation: (client: TClient, signal: AbortSignal) => Promise<T>): Promise<T>
  async withClient<T>(operation: (client: McpProtocolClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.current
    if (generation === undefined) throw new Error(`MCP server '${this.serverName}' is not connected`)
    const message = `MCP operation on '${this.serverName}' exceeded ${this.operationTimeoutMs}ms`
    try {
      return await withAbortTimeout(
        signal => Promise.resolve().then(() => operation(generation as unknown as McpProtocolClient, signal)),
        this.operationTimeoutMs,
        message,
      )
    } catch (error: unknown) {
      if (error instanceof McpOperationTimeoutError && this.current === generation) {
        this.current = undefined
        clearTools(this.connectionHost())
        await this.closeGeneration(generation)
        if (!this.closed) this.scheduleReconnect(error)
      }
      throw error
    }
  }

  /** Connect, negotiate capabilities, and publish the first tool snapshot. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`MCP client '${this.serverName}' is closed`))
    if (this.current !== undefined
      && (this.currentState.status === 'ready' || this.currentState.status === 'scope-authorization-required')) {
      return Promise.resolve()
    }
    if (this.pendingAuthorization !== undefined) {
      return Promise.reject(new Error(`MCP client '${this.serverName}' is waiting for its OAuth callback`))
    }
    if (this.connecting !== undefined) return this.connecting
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const attempt = connectGeneration(this.connectionHost(), this.currentState.status === 'reconnecting')
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined
    })
    this.connecting = tracked
    return tracked
  }

  /** Force a fresh tools/list and atomically replace the published snapshot. */
  refreshTools(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const generation = this.current
    if (generation === undefined) return Promise.reject(new Error(`MCP server '${this.serverName}' is not connected`))
    return enqueueToolSync(this.connectionHost(), generation, undefined, options.signal)
  }

  /**
   * Validate an OAuth callback, exchange its authorization code on the pending
   * HTTP transport, then reconnect with a fresh transport generation.
   */
  async finishOAuth(
    callbackParams: URLSearchParams,
    options: McpOAuthCallbackOptions,
  ): Promise<void> {
    if (this.closed) throw new Error(`MCP client '${this.serverName}' is closed`)
    const pending = this.pendingAuthorization
    if (pending === undefined) throw new Error(`MCP client '${this.serverName}' has no pending OAuth authorization`)
    if (options.expectedState.length === 0 || callbackParams.get('state') !== options.expectedState) {
      throw new Error(`MCP client '${this.serverName}' rejected an OAuth callback with mismatched state`)
    }
    if (callbackParams.has('error')) {
      throw new Error(`MCP client '${this.serverName}' OAuth authorization was denied or failed`)
    }

    const operation = beginIntegrationOperation(this.options.logger, this.integrationFamily, 'authenticate')
    const attempt = operation.attempt(1)
    this.pendingAuthorization = undefined
    try {
      await withAbortTimeout(
        () => pending.transport.finishAuth(callbackParams),
        this.operationTimeoutMs,
        `MCP OAuth callback exceeded ${this.operationTimeoutMs}ms`,
        options.signal,
      )
      attempt.success()
      operation.success()
    } catch (error: unknown) {
      attempt.fail(integrationErrorCode(error))
      operation.fail(integrationErrorCode(error))
      const failure = errorOf(error)
      this.publish('failed', this.reconnectAttempts, failure)
      throw failure
    } finally {
      await this.closeGeneration(pending.client)
    }
    await this.connect()
  }

  /** Stop reconnecting, close the live generation, and unregister its tools. */
  async close(): Promise<void> { await this.closeWithReport() }

  closeWithReport(options: { readonly signal?: AbortSignal } = {}): Promise<McpCloseReport> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closeTask = this.performClose(options.signal)
    return this.closeTask
  }

  private connectionHost(): McpConnectionHost {
    const connection = this
    return {
      get serverName() { return connection.serverName },
      get options() { return connection.options },
      get transportFactory() { return connection.transportFactory },
      get fallbackTransportFactory() { return connection.fallbackTransportFactory },
      get authenticationKind() { return connection.authenticationKind },
      get integrationFamily() { return connection.integrationFamily },
      get toolCallTimeoutMs() { return connection.toolCallTimeoutMs },
      get operationTimeoutMs() { return connection.operationTimeoutMs },
      get maxTools() { return connection.maxTools },
      get maxCatalogBytes() { return connection.maxCatalogBytes },
      get maxToolResultBytes() { return connection.maxToolResultBytes },
      get registry() { return connection.registry },
      get toolDisposers() { return connection.toolDisposers },
      set toolDisposers(value) { connection.toolDisposers = value },
      get current() { return connection.current },
      set current(value) { connection.current = value },
      get pendingAuthorization() { return connection.pendingAuthorization },
      set pendingAuthorization(value) { connection.pendingAuthorization = value },
      get syncTail() { return connection.syncTail },
      set syncTail(value) { connection.syncTail = value },
      get pendingToolSyncs() { return connection.pendingToolSyncs },
      set pendingToolSyncs(value) { connection.pendingToolSyncs = value },
      get reconnectAttempts() { return connection.reconnectAttempts },
      get catalogRevision() { return connection.catalogRevision },
      set catalogRevision(value) { connection.catalogRevision = value },
      get connectedAt() { return connection.connectedAt },
      set connectedAt(value) { connection.connectedAt = value },
      get closed() { return connection.closed },
      get currentState() { return connection.currentState },
      set currentState(value) { connection.currentState = value },
      generationDown: (...args) => connection.generationDown(...args),
      scheduleReconnect: (...args) => connection.scheduleReconnect(...args),
      closeGeneration: (...args) => connection.closeGeneration(...args),
      publish: (...args) => connection.publish(...args),
    }
  }

  private addGenerationCleanup(tasks: (() => Promise<unknown>)[], generation: Client | undefined): void {
    if (generation !== undefined) {
      try {
        const transport = generation.transport
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined) {
          tasks.push(() => transport.terminateSession())
        }
      } catch { /* connection may still be initializing */ }
      tasks.push(() => generation.close())
    }
  }

  private async performClose(signal?: AbortSignal): Promise<McpCloseReport> {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const generation = this.current
    this.current = undefined
    const tasks: (() => Promise<unknown>)[] = []
    this.addGenerationCleanup(tasks, generation)
    const pending = this.pendingAuthorization
    this.pendingAuthorization = undefined
    if (pending !== undefined && pending.client !== generation) {
      tasks.push(() => pending.client.close())
    }
    const connecting = this.connecting
    if (connecting !== undefined) tasks.push(() => connecting)
    if (this.pendingToolSyncs > 0) tasks.push(() => this.syncTail)
    const report = await executeMcpClosePlan({
      ...this.options.logger === undefined ? {} : { logger: this.options.logger },
      family: this.integrationFamily, ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.closeTimeoutMs, tasks,
    })
    clearTools(this.connectionHost(), )
    this.publish('closed', this.reconnectAttempts)
    return report
  }

  private generationDown(generation: Client): void {
    if (this.closed || this.current !== generation) return
    this.current = undefined
    this.scheduleReconnect(new Error(`MCP connection '${this.serverName}' closed`))
  }

  private scheduleReconnect(error: Error): void {
    if (this.closed || this.reconnectTimer !== undefined) return
    const policy = this.reconnect
    if (!policy.enabled) {
      this.publish('failed', this.reconnectAttempts, error)
      return
    }
    if (this.connectedAt !== undefined && Date.now() - this.connectedAt >= policy.maxDelayMs) {
      this.reconnectAttempts = 0
    }
    this.connectedAt = undefined
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > policy.maxAttempts) {
      clearTools(this.connectionHost(), )
      this.publish('failed', policy.maxAttempts, error)
      return
    }
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (this.reconnectAttempts - 1))
    this.publish('reconnecting', this.reconnectAttempts, error)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => undefined)
    }, delay)
    const timer = this.reconnectTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }

  private async closeGeneration(generation: Client): Promise<boolean> {
    const report = await executeMcpClosePlan({ family: this.integrationFamily,
      timeoutMs: this.closeTimeoutMs, tasks: [() => generation.close()] })
    return report.error === undefined
  }

  private publish(
    status: McpClientStatus,
    attempt: number,
    error?: Error,
    details: { readonly authorization?: McpAuthorizationState; readonly protocol?: McpProtocolState } = {},
  ): void {
    this.currentState = Object.freeze({
      status,
      serverName: this.serverName,
      attempt,
      catalogRevision: this.catalogRevision,
      ...(error === undefined ? {} : { error }),
      ...(error === undefined ? {} : {
        supportError: mcpSupportError(
          integrationErrorCode(error), 'mcp-client', 'MCP client operation failed',
        ),
      }),
      ...(details.authorization === undefined ? {} : { authorization: Object.freeze(details.authorization) }),
      ...(details.protocol === undefined ? {} : { protocol: Object.freeze(details.protocol) }),
    })
    try { this.options.onStateChange?.(this.currentState) }
    catch { /* lifecycle observers do not own connection state */ }
  }
}

export { McpConnectionError, McpRemoteToolError } from './result.ts'
export { resolveMcpReconnectOptions } from './runtime-helpers.ts'
