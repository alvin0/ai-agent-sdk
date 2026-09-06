/** MCP client lifecycle and remote-tool bridge for Universal runtimes. */
import {
  Client,
  InsufficientScopeError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type ClientOptions,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client'
import type { JsonValue } from '@ai-agent-sdk/core'
import {
  ToolRegistry,
  type ToolCatalog,
  type ToolCatalogSnapshot,
  type ToolDefinition,
  type ToolSource,
  type ToolSourceSnapshotOptions,
} from '@ai-agent-sdk/core/tools'
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
  McpTransportKind,
  ResolvedMcpReconnectOptions,
} from './api-types.ts'
import {
  McpRemoteToolError,
  normalizeResult,
  protocolState,
  renderMcpResult,
} from './result.ts'
import { beginIntegrationOperation, integrationErrorCode,
  type McpIntegrationFamily } from '../common/integration-operation.ts'
import { executeMcpClosePlan } from './close.ts'
import { mcpSupportError } from '../common/support-error.ts'
import { MCP_CLIENT_DEFAULTS } from './config.ts'
import {
  McpOperationTimeoutError,
  assertServerName,
  errorOf,
  filterRemoteTools,
  isJsonObject,
  positiveSafeInteger,
  timeoutMilliseconds,
  publicToolName,
  raceAbort,
  resolveMcpReconnectOptions,
  serializedBytes,
  withAbortTimeout,
} from './runtime-helpers.ts'

export type * from './public-types.ts'
export type * from './api-types.ts'

type OAuthCapableTransport = StreamableHTTPClientTransport | SSEClientTransport

interface PendingHttpAuthorization {
  readonly client: Client
  readonly transport: OAuthCapableTransport
}

function isOAuthCapableTransport(transport: Transport | undefined): transport is OAuthCapableTransport {
  return transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport
}

function transportKindOf(transport: Transport): McpTransportKind {
  if (transport instanceof StreamableHTTPClientTransport) return 'streamable-http'
  if (transport instanceof SSEClientTransport) return 'sse'
  return 'custom'
}

function shouldTryLegacyTransport(error: unknown): boolean {
  if (UnauthorizedError.isInstance(error) || InsufficientScopeError.isInstance(error)) return false
  return !(error instanceof Error && error.name === 'AbortError')
}

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
    const toolFilter = options.toolFilter === undefined ? undefined : Object.freeze({
      ...(options.toolFilter.allow === undefined ? {} : { allow: Object.freeze([...options.toolFilter.allow]) }),
      ...(options.toolFilter.deny === undefined ? {} : { deny: Object.freeze([...options.toolFilter.deny]) }),
    })
    this.reconnect = resolveMcpReconnectOptions(options.reconnect)
    this.options = Object.freeze({ ...options, ...(toolFilter === undefined ? {} : { toolFilter }) })
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
        this.clearTools()
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
    const attempt = this.connectGeneration(this.currentState.status === 'reconnecting')
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
    return this.enqueueToolSync(generation, undefined, options.signal)
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

  private async performClose(signal?: AbortSignal): Promise<McpCloseReport> {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const generation = this.current
    this.current = undefined
    const tasks: (() => Promise<unknown>)[] = []
    if (generation !== undefined) {
      try {
        const transport = generation.transport
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined) {
          tasks.push(() => transport.terminateSession())
        }
      } catch { /* connection may still be initializing */ }
      tasks.push(() => generation.close())
    }
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
    this.clearTools()
    this.publish('closed', this.reconnectAttempts)
    return report
  }

  private async connectGeneration(reconnecting: boolean): Promise<void> {
    const attempt = reconnecting ? this.reconnectAttempts : 0
    const operation = beginIntegrationOperation(
      this.options.logger,
      this.integrationFamily,
      reconnecting ? 'reconnect' : 'connect',
    )
    this.publish(reconnecting ? 'reconnecting' : 'connecting', attempt)
    const factories = [this.transportFactory, this.fallbackTransportFactory]
      .filter((factory): factory is McpTransportFactory => factory !== undefined)
    let lastFailure: Error | undefined

    for (let index = 0; index < factories.length; index++) {
      const physicalAttempt = operation.attempt(index + 1)
      let generation: Client
      try { generation = this.createGeneration() }
      catch (error: unknown) {
        const code = integrationErrorCode(error)
        physicalAttempt.fail(code); operation.fail(code)
        throw error
      }
      let starting = true
      let transport: Transport | undefined
      this.current = generation
      generation.onclose = () => {
        if (!starting) this.generationDown(generation)
      }
      try {
        const openedTransport = (factories[index] as McpTransportFactory)() as unknown as Transport
        transport = openedTransport
        await withAbortTimeout(
          () => generation.connect(openedTransport),
          this.operationTimeoutMs,
          `MCP connection '${this.serverName}' exceeded ${this.operationTimeoutMs}ms`,
          this.options.signal,
        )
        if (this.current !== generation || this.closed) throw new Error(`MCP connection '${this.serverName}' closed during startup`)
        await this.enqueueToolSync(generation, undefined, this.options.signal)
        if (this.current !== generation || this.closed) throw new Error(`MCP connection '${this.serverName}' closed during tool discovery`)
        this.connectedAt = Date.now()
        starting = false
        this.publish('ready', this.reconnectAttempts, undefined, {
          protocol: protocolState(generation, transportKindOf(transport), index > 0),
        })
        physicalAttempt.success()
        operation.success()
        if (this.authenticationKind !== 'none' && this.authenticationKind !== 'unknown') {
          const authentication = beginIntegrationOperation(
            this.options.logger, this.integrationFamily, 'authenticate',
          )
          authentication.attempt(1).success()
          authentication.success()
        }
        return
      } catch (error: unknown) {
        physicalAttempt.fail(integrationErrorCode(error))
        starting = false
        const failure = errorOf(error)
        lastFailure = failure
        if (this.current === generation) this.current = undefined

        if (UnauthorizedError.isInstance(error)) {
          if (this.authenticationKind === 'oauth' && isOAuthCapableTransport(transport)) {
            this.pendingAuthorization = { client: generation, transport }
            this.publish('oauth-authorization-required', this.reconnectAttempts, failure, {
              authorization: { kind: 'oauth', reason: 'authorization-code-required' },
            })
            operation.fail(integrationErrorCode(error))
            this.logAuthenticationFailure(error)
            throw failure
          }
          await this.closeGeneration(generation)
          const status = this.authenticationKind === 'bearer' ? 'authentication-failed' : 'authentication-required'
          this.publish(status, this.reconnectAttempts, failure, {
            authorization: {
              kind: this.authenticationKind,
              reason: this.authenticationKind === 'bearer' ? 'invalid-credentials' : 'credentials-required',
            },
          })
          operation.fail(integrationErrorCode(error))
          this.logAuthenticationFailure(error)
          throw failure
        }

        await this.closeGeneration(generation)
        const canFallback = index + 1 < factories.length && shouldTryLegacyTransport(error)
        if (canFallback) continue
        if (!this.closed) this.scheduleReconnect(failure)
        operation.fail(integrationErrorCode(error))
        throw failure
      }
    }
    const failure = lastFailure ?? new Error(`MCP connection '${this.serverName}' has no transport candidate`)
    if (!this.closed) this.scheduleReconnect(failure)
    operation.fail(integrationErrorCode(failure))
    throw failure
  }

  private createGeneration(): Client {
    let generation!: Client
    generation = new Client(
      {
        name: this.options.clientName ?? 'ai-agent-sdk',
        version: this.options.clientVersion ?? '0.0.0',
      },
      this.clientOptions((error, items) => {
        if (this.current !== generation || this.closed) return
        if (error !== null || items === null) {
          try {
            this.options.onStateChange?.(Object.freeze({
              ...this.currentState,
              ...(error === null ? {} : { error }),
              ...(error === null ? {} : {
                supportError: mcpSupportError(
                  integrationErrorCode(error), 'mcp-client', 'MCP client operation failed',
                ),
              }),
            }))
          } catch { /* lifecycle observers do not own connection state */ }
          return
        }
        void this.enqueueToolSync(generation, items).catch(error => {
          try {
            this.options.onStateChange?.(Object.freeze({
              ...this.currentState,
              error: errorOf(error),
              supportError: mcpSupportError(
                integrationErrorCode(error), 'mcp-client', 'MCP client operation failed',
              ),
            }))
          } catch { /* lifecycle observers do not own connection state */ }
        })
      }),
    )
    return generation
  }

  private clientOptions(onToolsChanged: (error: Error | null, tools: Tool[] | null) => void): ClientOptions {
    return {
      capabilities: {},
      versionNegotiation: { mode: this.options.protocol ?? 'auto' },
      listChanged: {
        tools: { autoRefresh: true, onChanged: onToolsChanged },
      },
    }
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
      this.clearTools()
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

  private enqueueToolSync(
    generation: Client,
    supplied?: readonly Tool[],
    callerSignal?: AbortSignal,
  ): Promise<void> {
    this.pendingToolSyncs += 1
    const run = this.syncTail.then(async () => {
      if (this.closed || this.current !== generation) return
      const operation = beginIntegrationOperation(this.options.logger, this.integrationFamily, 'catalog-refresh')
      const attempt = operation.attempt(1)
      try {
        const tools = supplied ?? (await withAbortTimeout(
          signal => generation.listTools(undefined, { cacheMode: 'refresh', signal }),
          this.operationTimeoutMs,
          `MCP tool discovery exceeded ${this.operationTimeoutMs}ms`,
          callerSignal,
        )).tools
        if (this.closed || this.current !== generation) {
          attempt.abort(); operation.abort(); return
        }
        this.swapTools(tools)
        attempt.success(); operation.success()
      } catch (error: unknown) {
        attempt.fail(integrationErrorCode(error)); operation.fail(integrationErrorCode(error))
        throw error
      }
    })
    const tracked = run.finally(() => { this.pendingToolSyncs -= 1 })
    this.syncTail = tracked.catch(() => undefined)
    return tracked
  }

  private swapTools(remoteTools: readonly Tool[]): void {
    if (remoteTools.length > this.maxTools) {
      throw new RangeError(`MCP server '${this.serverName}' exceeds the ${this.maxTools}-tool limit`)
    }
    if (serializedBytes(remoteTools) > this.maxCatalogBytes) {
      throw new RangeError(`MCP server '${this.serverName}' catalog exceeds the ${this.maxCatalogBytes}-byte limit`)
    }
    const next = new ToolRegistry()
    const seen = new Set<string>()
    for (const remote of filterRemoteTools(remoteTools, this.options.toolFilter)) {
      const name = publicToolName(this.serverName, remote.name, this.options.prefixToolNames !== false)
      if (seen.has(name)) throw new Error(`MCP server '${this.serverName}' produced duplicate tool name '${name}'`)
      seen.add(name)
      next.register(this.bridgeTool(name, remote))
    }
    this.clearTools(false)
    this.toolDisposers = next.names().map(name => this.registry.register(next.get(name) as ToolDefinition))
    this.bumpCatalogRevision()
  }

  private bridgeTool(publicName: string, remote: Tool): ToolDefinition<Record<string, JsonValue>> {
    const inputSchema = isJsonObject(remote.inputSchema)
      ? structuredClone(remote.inputSchema)
      : { type: 'object', additionalProperties: true }
    return {
      name: publicName,
      description: remote.description?.trim() || `Tool '${remote.name}' from MCP server '${this.serverName}'.`,
      parameters: inputSchema,
      timeoutMs: this.toolCallTimeoutMs,
      parse: raw => {
        if (!isJsonObject(raw)) throw new TypeError('MCP tool arguments must be a JSON object')
        return raw
      },
      execute: async (args, context) => {
        const generation = this.current
        if (generation === undefined) throw new Error(`MCP server '${this.serverName}' is not connected`)
        const operation = beginIntegrationOperation(context.logger, this.integrationFamily, 'tool-call')
        const attempt = operation.attempt(1)
        try {
          const result = await raceAbort(generation.callTool(
            { name: remote.name, arguments: args },
            {
              signal: context.signal,
              toolDefinition: remote,
              timeout: this.toolCallTimeoutMs,
            },
          ), context.signal)
          if (serializedBytes(result) > this.maxToolResultBytes) {
            throw new RangeError(
              `MCP tool '${this.serverName}/${remote.name}' result exceeds the ${this.maxToolResultBytes}-byte limit`,
            )
          }
          if (result.isError === true) throw new McpRemoteToolError(this.serverName, remote.name, result)
          const normalized = normalizeResult(result)
          attempt.success(); operation.success()
          return normalized
        } catch (error: unknown) {
          if (context.signal.aborted) {
            attempt.abort(); operation.abort()
          } else {
            attempt.fail(integrationErrorCode(error)); operation.fail(integrationErrorCode(error))
          }
          if (InsufficientScopeError.isInstance(error)) {
            this.publish('scope-authorization-required', this.reconnectAttempts, errorOf(error), {
              authorization: {
                kind: this.authenticationKind,
                reason: 'insufficient-scope',
                ...(error.requiredScope === undefined ? {} : { requiredScope: error.requiredScope }),
              },
              ...(this.currentState.protocol === undefined ? {} : { protocol: this.currentState.protocol }),
            })
          } else if (UnauthorizedError.isInstance(error)) {
            const transport = generation.transport
            if (this.current === generation) this.current = undefined
            if (this.authenticationKind === 'oauth' && isOAuthCapableTransport(transport)) {
              this.pendingAuthorization = { client: generation, transport }
              this.publish('oauth-authorization-required', this.reconnectAttempts, errorOf(error), {
                authorization: { kind: 'oauth', reason: 'authorization-code-required' },
                ...(this.currentState.protocol === undefined ? {} : { protocol: this.currentState.protocol }),
              })
            } else {
              await this.closeGeneration(generation)
              this.publish(
                this.authenticationKind === 'bearer' ? 'authentication-failed' : 'authentication-required',
                this.reconnectAttempts,
                errorOf(error),
                {
                  authorization: {
                    kind: this.authenticationKind,
                    reason: this.authenticationKind === 'bearer' ? 'invalid-credentials' : 'credentials-required',
                  },
                  ...(this.currentState.protocol === undefined ? {} : { protocol: this.currentState.protocol }),
                },
              )
            }
          }
          throw error
        }
      },
      render: value => renderMcpResult(value),
      meta: () => ({ kind: 'mcp', serverName: this.serverName, remoteToolName: remote.name }),
      ...(this.options.trustReadOnlyAnnotations === true && remote.annotations?.readOnlyHint === true
        ? { isConcurrencySafe: () => true }
        : {}),
    }
  }

  private clearTools(recordRevision = true): void {
    if (this.toolDisposers.length === 0) return
    for (const dispose of this.toolDisposers) dispose()
    this.toolDisposers = []
    if (recordRevision) this.bumpCatalogRevision()
  }

  private bumpCatalogRevision(): void {
    if (this.catalogRevision < Number.MAX_SAFE_INTEGER) this.catalogRevision += 1
    this.currentState = Object.freeze({ ...this.currentState, catalogRevision: this.catalogRevision })
    try { this.options.onStateChange?.(this.currentState) } catch { /* observers do not own state */ }
  }

  private logAuthenticationFailure(error: unknown): void {
    const operation = beginIntegrationOperation(this.options.logger, this.integrationFamily, 'authenticate')
    const attempt = operation.attempt(1)
    const code = integrationErrorCode(error)
    attempt.fail(code)
    operation.fail(code)
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
    try { this.options.onStateChange?.(this.currentState) } catch { /* lifecycle observers do not own connection state */ }
  }
}

export { McpConnectionError, McpRemoteToolError } from './result.ts'
export { resolveMcpReconnectOptions } from './runtime-helpers.ts'
