/** MCP client lifecycle and remote-tool bridge for web-standard runtimes. */

import {
  Client,
  InsufficientScopeError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ClientOptions,
  type OAuthClientProvider,
  type SSEClientTransportOptions,
  type StreamableHTTPClientTransportOptions,
  type Tool,
  type Transport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client'
import type { ContentBlock, ImageMediaType } from '../core/message/content.ts'
import { isJsonValue, type JsonObject, type JsonValue } from '../core/primitives/json.ts'
import { ToolRegistry, type ToolCatalog, type ToolFilter } from '../agent/tool/registry.ts'
import type { ToolDefinition } from '../agent/tool/definition.ts'
import { waitForSettlement } from '../core/async/settlement.ts'

const DEFAULT_RECONNECT = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

export interface McpReconnectOptions {
  readonly enabled?: boolean
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxAttempts?: number
}

export interface ResolvedMcpReconnectOptions {
  readonly enabled: boolean
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

export type McpClientStatus =
  | 'idle'
  | 'connecting'
  /** @deprecated Observe the more specific authentication statuses instead. */
  | 'authorization-required'
  | 'authentication-required'
  | 'authentication-failed'
  | 'oauth-authorization-required'
  | 'scope-authorization-required'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export type McpAuthenticationKind = 'none' | 'bearer' | 'oauth' | 'unknown'
export type McpTransportKind = 'streamable-http' | 'sse' | 'custom'

export interface McpAuthorizationState {
  readonly kind: McpAuthenticationKind
  readonly reason: 'credentials-required' | 'invalid-credentials' | 'authorization-code-required' | 'insufficient-scope'
  readonly requiredScope?: string
}

export interface McpProtocolState {
  readonly era: 'modern' | 'legacy'
  readonly version?: string
  readonly transport: McpTransportKind
  /** True when the primary transport failed and the connection selected its legacy fallback. */
  readonly fallback: boolean
}

export interface McpClientState {
  readonly status: McpClientStatus
  readonly serverName: string
  readonly attempt: number
  readonly error?: Error
  readonly authorization?: McpAuthorizationState
  readonly protocol?: McpProtocolState
}

export interface McpClientLifecycleOptions {
  /** Stable namespace used in public tool names. */
  readonly serverName: string
  readonly clientName?: string
  readonly clientVersion?: string
  /** v2 defaults to auto negotiation while retaining 2025 compatibility. */
  readonly protocol?: VersionNegotiationMode
  readonly reconnect?: McpReconnectOptions | false
  readonly toolFilter?: ToolFilter
  /** Defaults to `mcp__<server>__<tool>` to avoid cross-server collisions. */
  readonly prefixToolNames?: boolean
  /** Remote tool deadline. Defaults to 120 seconds. */
  readonly toolCallTimeoutMs?: number
  /** Connect, discovery, OAuth, and withClient operation deadline. Defaults to 120 seconds. */
  readonly operationTimeoutMs?: number
  /** Maximum wait for transport/client teardown. Defaults to 30 seconds. */
  readonly closeTimeoutMs?: number
  /** Maximum tools accepted from one server catalog. Defaults to 1,024. */
  readonly maxTools?: number
  /** Maximum serialized bytes accepted for one tool catalog. Defaults to 4 MiB. */
  readonly maxCatalogBytes?: number
  /** Maximum serialized bytes accepted from one remote tool result. Defaults to 4 MiB. */
  readonly maxToolResultBytes?: number
  /** Trusting readOnlyHint is opt-in because MCP annotations are advisory. */
  readonly trustReadOnlyAnnotations?: boolean
  readonly onStateChange?: (state: McpClientState) => void
}

export interface McpHttpClientOptions extends McpClientLifecycleOptions {
  readonly url: string | URL
  readonly headers?: RequestInit['headers']
  /** Restrict every initial and redirected HTTP request to these origins. */
  readonly allowedOrigins?: readonly string[]
  /** Require HTTPS for every initial and redirected HTTP request. */
  readonly requireHttps?: boolean
  /** Set false to reject local/private hostname literals. */
  readonly allowPrivateNetwork?: boolean
  /** Set false to reject redirects at the fetch boundary. */
  readonly allowRedirects?: boolean
  /** Additional synchronous endpoint policy applied to initial and final URLs. */
  readonly validateEndpoint?: (url: URL) => void
  /** Maximum bytes accepted from one HTTP response before protocol parsing. Defaults to 16 MiB. */
  readonly maxTransportBytes?: number
  readonly transport?: Omit<StreamableHTTPClientTransportOptions, 'requestInit'> & {
    readonly requestInit?: RequestInit
  }
  /**
   * Streamable HTTP remains primary. Unless disabled, a failed non-auth startup
   * retries once using the deprecated SSE transport for older MCP servers.
   */
  readonly legacySse?: false | {
    readonly url?: string | URL
    readonly transport?: SSEClientTransportOptions
  }
}

export interface McpToolResultValue extends JsonObject {
  readonly content: readonly JsonValue[]
  readonly structuredContent?: JsonValue
}

export type McpTransportFactory = () => Transport

export interface McpClientRuntimeOptions {
  readonly authenticationKind?: McpAuthenticationKind
  readonly fallbackTransportFactory?: McpTransportFactory
}

type OAuthCapableTransport = StreamableHTTPClientTransport | SSEClientTransport

interface PendingHttpAuthorization {
  readonly client: Client
  readonly transport: OAuthCapableTransport
}

export interface McpOAuthCallbackOptions {
  /** OAuth state generated before redirect; required because the MCP SDK does not validate it. */
  readonly expectedState: string
}

/**
 * Owns one MCP server connection across transport generations.
 *
 * The ToolCatalog object is stable for the lifetime of this connection. A
 * successful list refresh swaps its registrations synchronously; a failed
 * refresh leaves the last-known-good catalog intact.
 */
export class McpClientConnection {
  readonly serverName: string
  readonly tools: ToolCatalog

  private readonly options: McpClientLifecycleOptions
  private readonly transportFactory: McpTransportFactory
  private readonly fallbackTransportFactory: McpTransportFactory | undefined
  private readonly authenticationKind: McpAuthenticationKind
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
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private connectedAt: number | undefined
  private closed = false
  private currentState: McpClientState

  constructor(
    options: McpClientLifecycleOptions,
    transportFactory: McpTransportFactory,
    runtime: McpClientRuntimeOptions = {},
  ) {
    assertServerName(options.serverName)
    this.toolCallTimeoutMs = positiveSafeInteger(options.toolCallTimeoutMs ?? 120_000, 'toolCallTimeoutMs')
    this.operationTimeoutMs = positiveSafeInteger(options.operationTimeoutMs ?? 120_000, 'operationTimeoutMs')
    this.closeTimeoutMs = positiveSafeInteger(options.closeTimeoutMs ?? 30_000, 'closeTimeoutMs')
    this.maxTools = positiveSafeInteger(options.maxTools ?? 1_024, 'maxTools')
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes')
    this.maxToolResultBytes = positiveSafeInteger(options.maxToolResultBytes ?? 4 * 1024 * 1024, 'maxToolResultBytes')
    const toolFilter = options.toolFilter === undefined ? undefined : Object.freeze({
      ...(options.toolFilter.allow === undefined ? {} : { allow: Object.freeze([...options.toolFilter.allow]) }),
      ...(options.toolFilter.deny === undefined ? {} : { deny: Object.freeze([...options.toolFilter.deny]) }),
    })
    this.reconnect = resolveMcpReconnectOptions(options.reconnect)
    this.options = Object.freeze({ ...options, ...(toolFilter === undefined ? {} : { toolFilter }) })
    this.transportFactory = transportFactory
    this.fallbackTransportFactory = runtime.fallbackTransportFactory
    this.authenticationKind = runtime.authenticationKind ?? 'unknown'
    this.serverName = options.serverName
    this.tools = this.registry
    this.currentState = Object.freeze({ status: 'idle', serverName: options.serverName, attempt: 0 })
  }

  get state(): McpClientState { return this.currentState }

  /**
   * Use the currently owned protocol client for resources, prompts, or other
   * MCP operations that do not map to the SDK ToolCatalog.
   */
  async withClient<T>(operation: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.current
    if (generation === undefined) throw new Error(`MCP server '${this.serverName}' is not connected`)
    const message = `MCP operation on '${this.serverName}' exceeded ${this.operationTimeoutMs}ms`
    try {
      return await withAbortTimeout(
        signal => Promise.resolve().then(() => operation(generation, signal)),
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
  refreshTools(): Promise<void> {
    const generation = this.current
    if (generation === undefined) return Promise.reject(new Error(`MCP server '${this.serverName}' is not connected`))
    return this.enqueueToolSync(generation)
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

    this.pendingAuthorization = undefined
    try {
      await withTimeout(
        pending.transport.finishAuth(callbackParams),
        this.operationTimeoutMs,
        `MCP OAuth callback exceeded ${this.operationTimeoutMs}ms`,
      )
    } catch (error: unknown) {
      const failure = errorOf(error)
      this.publish('failed', this.reconnectAttempts, failure)
      throw failure
    } finally {
      await this.closeGeneration(pending.client)
    }
    await this.connect()
  }

  /** Stop reconnecting, close the live generation, and unregister its tools. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const generation = this.current
    this.current = undefined
    if (generation !== undefined) {
      try {
        const transport = generation.transport
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined) {
          await waitForSettlement(
            transport.terminateSession().catch(() => undefined),
            this.closeTimeoutMs,
          )
        }
      } catch { /* connection may still be initializing */ }
      await this.closeGeneration(generation)
    }
    const pending = this.pendingAuthorization
    this.pendingAuthorization = undefined
    if (pending !== undefined && pending.client !== generation) {
      await this.closeGeneration(pending.client)
    }
    if (this.connecting !== undefined) await waitForSettlement(this.connecting, this.closeTimeoutMs)
    await waitForSettlement(this.syncTail, this.closeTimeoutMs)
    this.clearTools()
    this.publish('closed', this.reconnectAttempts)
  }

  private async connectGeneration(reconnecting: boolean): Promise<void> {
    const attempt = reconnecting ? this.reconnectAttempts : 0
    this.publish(reconnecting ? 'reconnecting' : 'connecting', attempt)
    const factories = [this.transportFactory, this.fallbackTransportFactory]
      .filter((factory): factory is McpTransportFactory => factory !== undefined)
    let lastFailure: Error | undefined

    for (let index = 0; index < factories.length; index++) {
      const generation = this.createGeneration()
      let starting = true
      let transport: Transport | undefined
      this.current = generation
      generation.onclose = () => {
        if (!starting) this.generationDown(generation)
      }
      try {
        transport = (factories[index] as McpTransportFactory)()
        await withTimeout(
          generation.connect(transport),
          this.operationTimeoutMs,
          `MCP connection '${this.serverName}' exceeded ${this.operationTimeoutMs}ms`,
        )
        if (this.current !== generation || this.closed) throw new Error(`MCP connection '${this.serverName}' closed during startup`)
        await this.enqueueToolSync(generation)
        if (this.current !== generation || this.closed) throw new Error(`MCP connection '${this.serverName}' closed during tool discovery`)
        this.connectedAt = Date.now()
        starting = false
        this.publish('ready', this.reconnectAttempts, undefined, {
          protocol: protocolState(generation, transport, index > 0),
        })
        return
      } catch (error: unknown) {
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
          throw failure
        }

        await this.closeGeneration(generation)
        const canFallback = index + 1 < factories.length && shouldTryLegacyTransport(error)
        if (canFallback) continue
        if (!this.closed) this.scheduleReconnect(failure)
        throw failure
      }
    }
    const failure = lastFailure ?? new Error(`MCP connection '${this.serverName}' has no transport candidate`)
    if (!this.closed) this.scheduleReconnect(failure)
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
            }))
          } catch { /* lifecycle observers do not own connection state */ }
          return
        }
        void this.enqueueToolSync(generation, items).catch(error => {
          try {
            this.options.onStateChange?.(Object.freeze({
              ...this.currentState,
              error: errorOf(error),
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

  private enqueueToolSync(generation: Client, supplied?: readonly Tool[]): Promise<void> {
    const run = this.syncTail.then(async () => {
      if (this.closed || this.current !== generation) return
      const tools = supplied ?? (await withAbortTimeout(
        signal => generation.listTools(undefined, { cacheMode: 'refresh', signal }),
        this.operationTimeoutMs,
        `MCP tool discovery exceeded ${this.operationTimeoutMs}ms`,
      )).tools
      if (this.closed || this.current !== generation) return
      this.swapTools(tools)
    })
    this.syncTail = run.catch(() => undefined)
    return run
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
    this.clearTools()
    this.toolDisposers = next.names().map(name => this.registry.register(next.get(name) as ToolDefinition))
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
          return normalizeResult(result)
        } catch (error: unknown) {
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

  private clearTools(): void {
    for (const dispose of this.toolDisposers) dispose()
    this.toolDisposers = []
  }

  private async closeGeneration(generation: Client): Promise<void> {
    const closing = Promise.resolve().then(() => generation.close()).catch(() => undefined)
    await waitForSettlement(closing, this.closeTimeoutMs)
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
      ...(error === undefined ? {} : { error }),
      ...(details.authorization === undefined ? {} : { authorization: Object.freeze(details.authorization) }),
      ...(details.protocol === undefined ? {} : { protocol: Object.freeze(details.protocol) }),
    })
    try { this.options.onStateChange?.(this.currentState) } catch { /* lifecycle observers do not own connection state */ }
  }
}

export class McpRemoteToolError extends Error {
  readonly result: CallToolResult
  constructor(serverName: string, toolName: string, result: CallToolResult) {
    super(`MCP tool '${serverName}/${toolName}' failed: ${resultText(result)}`)
    this.name = 'McpRemoteToolError'
    this.result = result
  }
}

/** Construct an HTTP client without opening the connection yet. */
export function createMcpHttpClient(options: McpHttpClientOptions): McpClientConnection {
  const security = snapshotHttpSecurityOptions(options)
  const url = validateHttpEndpoint(options.url, security)
  const {
    url: _url,
    headers,
    transport,
    legacySse,
    allowedOrigins: _allowedOrigins,
    requireHttps: _requireHttps,
    allowPrivateNetwork: _allowPrivateNetwork,
    allowRedirects: _allowRedirects,
    validateEndpoint: _validateEndpoint,
    maxTransportBytes: _maxTransportBytes,
    ...lifecycle
  } = options
  const legacyOptions = legacySse === false ? undefined : legacySse
  const primaryFactory = (): Transport => {
    const requestInit = { ...transport?.requestInit }
    if (headers !== undefined) requestInit.headers = mergeHeaders(transport?.requestInit?.headers, headers)
    const guardedFetch = createGuardedMcpFetch(transport?.fetch ?? globalThis.fetch, security)
    return new StreamableHTTPClientTransport(url, {
      ...transport,
      fetch: guardedFetch,
      ...(Object.keys(requestInit).length === 0 ? {} : { requestInit }),
    })
  }
  const fallbackFactory = legacySse === false ? undefined : (): Transport => {
    const fallbackUrl = validateHttpEndpoint(legacyOptions?.url ?? url, security)
    const fallbackOptions = legacyOptions?.transport
    const requestInit = { ...fallbackOptions?.requestInit }
    if (headers !== undefined) requestInit.headers = mergeHeaders(fallbackOptions?.requestInit?.headers, headers)
    const guardedFetch = createGuardedMcpFetch(fallbackOptions?.fetch ?? transport?.fetch ?? globalThis.fetch, security)
    return new SSEClientTransport(fallbackUrl, {
      ...fallbackOptions,
      ...(fallbackOptions?.authProvider === undefined && transport?.authProvider !== undefined
        ? { authProvider: transport.authProvider }
        : {}),
      fetch: guardedFetch,
      ...(Object.keys(requestInit).length === 0 ? {} : { requestInit }),
    })
  }
  return new McpClientConnection(lifecycle, primaryFactory, {
    authenticationKind: authenticationKindOf(
      transport?.authProvider,
      mergeHeaders(transport?.requestInit?.headers, headers),
    ),
    ...(fallbackFactory === undefined ? {} : { fallbackTransportFactory: fallbackFactory }),
  })
}

/** Construct and fully initialize an HTTP client. */
export async function connectMcpHttp(options: McpHttpClientOptions): Promise<McpClientConnection> {
  const connection = createMcpHttpClient(options)
  try {
    await connection.connect()
    return connection
  } catch (error: unknown) {
    await connection.close()
    throw error
  }
}

export function resolveMcpReconnectOptions(
  input: McpReconnectOptions | false | undefined,
): ResolvedMcpReconnectOptions {
  if (input === false) return Object.freeze({ ...DEFAULT_RECONNECT, enabled: false })
  const resolved = {
    enabled: input?.enabled ?? DEFAULT_RECONNECT.enabled,
    initialDelayMs: input?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
    maxDelayMs: input?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    maxAttempts: input?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
  }
  assertPositive(resolved.initialDelayMs, 'reconnect.initialDelayMs')
  assertPositive(resolved.maxDelayMs, 'reconnect.maxDelayMs')
  if (resolved.initialDelayMs > resolved.maxDelayMs) {
    throw new TypeError('reconnect.initialDelayMs must be less than or equal to reconnect.maxDelayMs')
  }
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new TypeError('reconnect.maxAttempts must be a positive integer')
  }
  return Object.freeze(resolved)
}

function authenticationKindOf(
  provider: StreamableHTTPClientTransportOptions['authProvider'] | undefined,
  headers: Headers,
): McpAuthenticationKind {
  if (provider === undefined) return headers.has('authorization') ? 'bearer' : 'none'
  return isOAuthClientProvider(provider) ? 'oauth' : 'bearer'
}

function isOAuthClientProvider(provider: unknown): provider is OAuthClientProvider {
  if (typeof provider !== 'object' || provider === null) return false
  const candidate = provider as Partial<OAuthClientProvider>
  return typeof candidate.clientInformation === 'function'
    && typeof candidate.tokens === 'function'
    && typeof candidate.saveTokens === 'function'
    && typeof candidate.redirectToAuthorization === 'function'
    && typeof candidate.saveCodeVerifier === 'function'
    && typeof candidate.codeVerifier === 'function'
}

function isOAuthCapableTransport(transport: Transport | undefined): transport is OAuthCapableTransport {
  return transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport
}

function protocolState(client: Client, transport: Transport, fallback: boolean): McpProtocolState {
  const version = client.getNegotiatedProtocolVersion()
  return Object.freeze({
    era: client.getProtocolEra() ?? 'legacy',
    ...(version === undefined ? {} : { version }),
    transport: transportKindOf(transport),
    fallback,
  })
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

function filterRemoteTools(tools: readonly Tool[], filter: ToolFilter | undefined): readonly Tool[] {
  const allow = filter?.allow === undefined ? undefined : new Set(filter.allow)
  const deny = new Set(filter?.deny ?? [])
  return tools.filter(tool => (allow === undefined || allow.has(tool.name)) && !deny.has(tool.name))
}

function publicToolName(serverName: string, remoteName: string, prefixed: boolean): string {
  return prefixed ? `mcp__${serverName}__${remoteName}` : remoteName
}

function normalizeResult(result: CallToolResult): McpToolResultValue {
  const content = result.content.map((block, index) => {
    if (!isJsonValue(block)) throw new TypeError(`MCP result content[${index}] is not lossless JSON`)
    return block
  })
  const structured = result.structuredContent
  if (structured !== undefined && !isJsonValue(structured)) {
    throw new TypeError('MCP structuredContent is not lossless JSON')
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  }
}

function renderMcpResult(value: JsonValue | undefined): readonly ContentBlock[] {
  if (!isJsonObject(value) || !Array.isArray(value.content)) {
    return [{ type: 'text', text: value === undefined ? '(no output)' : JSON.stringify(value, null, 2) }]
  }
  const blocks = value.content.flatMap(block => renderRemoteBlock(block))
  return blocks.length === 0 ? [{ type: 'text', text: '(no output)' }] : blocks
}

function renderRemoteBlock(value: JsonValue): ContentBlock[] {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
  if (value.type === 'text' && typeof value.text === 'string') return [{ type: 'text', text: value.text }]
  if (value.type === 'image'
    && typeof value.data === 'string'
    && typeof value.mimeType === 'string'
    && isImageMediaType(value.mimeType)) {
    return [{ type: 'image', source: { kind: 'base64', mediaType: value.mimeType, data: value.data } }]
  }
  if (value.type === 'resource' && isJsonObject(value.resource) && typeof value.resource.text === 'string') {
    return [{ type: 'text', text: value.resource.text }]
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    const name = typeof value.name === 'string' ? value.name : value.uri
    return [{ type: 'text', text: `[MCP resource: ${name}](${value.uri})` }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function resultText(result: CallToolResult): string {
  const text = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || 'remote tool returned an error'
}

interface McpHttpSecurityOptions {
  readonly allowedOrigins?: readonly string[]
  readonly requireHttps: boolean
  readonly allowPrivateNetwork: boolean
  readonly allowRedirects: boolean
  readonly validateEndpoint?: (url: URL) => void
  readonly maxTransportBytes: number
  readonly timeoutMs: number
  readonly teardownTimeoutMs: number
}

type McpFetch = NonNullable<StreamableHTTPClientTransportOptions['fetch']>

function snapshotHttpSecurityOptions(options: McpHttpClientOptions): McpHttpSecurityOptions {
  const allowedOrigins = options.allowedOrigins?.map((origin, index) => {
    let url: URL
    try { url = new URL(origin) } catch { throw new TypeError(`allowedOrigins[${index}] must be an absolute URL`) }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError(`allowedOrigins[${index}] must not contain credentials`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`allowedOrigins[${index}] must use http or https`)
    }
    return url.origin
  })
  return Object.freeze({
    ...(allowedOrigins === undefined ? {} : { allowedOrigins: Object.freeze([...new Set(allowedOrigins)]) }),
    requireHttps: options.requireHttps === true,
    allowPrivateNetwork: options.allowPrivateNetwork !== false,
    allowRedirects: options.allowRedirects !== false,
    ...(options.validateEndpoint === undefined ? {} : { validateEndpoint: options.validateEndpoint }),
    maxTransportBytes: positiveSafeInteger(options.maxTransportBytes ?? 16 * 1024 * 1024, 'maxTransportBytes'),
    timeoutMs: positiveSafeInteger(options.operationTimeoutMs ?? 120_000, 'operationTimeoutMs'),
    teardownTimeoutMs: positiveSafeInteger(options.closeTimeoutMs ?? 30_000, 'closeTimeoutMs'),
  })
}

function validateHttpEndpoint(value: string | URL, options: McpHttpSecurityOptions): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('MCP HTTP endpoint URL must not contain credentials')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use http or https')
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP endpoint URL must use https under the configured policy')
  }
  if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
    throw new TypeError(`MCP HTTP endpoint origin '${url.origin}' is not allowed`)
  }
  if (!options.allowPrivateNetwork && isPrivateHostname(url.hostname)) {
    throw new TypeError(`MCP HTTP endpoint host '${url.hostname}' is private or local`)
  }
  options.validateEndpoint?.(new URL(url))
  return url
}

function createGuardedMcpFetch(baseFetch: McpFetch, options: McpHttpSecurityOptions): McpFetch {
  if (typeof baseFetch !== 'function') throw new TypeError('MCP HTTP transport requires fetch')
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    validateHttpEndpoint(input, options)
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = init?.signal == null ? timeout : AbortSignal.any([init.signal, timeout])
    const response = await raceAbort(Promise.resolve(baseFetch(input, {
      ...init,
      signal,
      ...(!options.allowRedirects ? { redirect: 'error' as const } : {}),
    })), signal)
    if (response.url.length > 0) validateHttpEndpoint(response.url, options)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > options.maxTransportBytes) {
      if (response.body !== null) {
        await waitForSettlement(response.body.cancel().catch(() => undefined), options.teardownTimeoutMs)
      }
      throw new Error(`MCP HTTP response exceeds the ${options.maxTransportBytes}-byte limit`)
    }
    if (response.body === null) return response
    let received = 0
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > options.maxTransportBytes) {
          controller.error(new Error(`MCP HTTP response exceeds the ${options.maxTransportBytes}-byte limit`))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as McpFetch
}

function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa') || !hostname.includes('.')) return true
  if (hostname.includes(':')) return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  const [first = 0, second = 0] = octets
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
}

function mergeHeaders(base: RequestInit['headers'], extra: RequestInit['headers']): Headers {
  const headers = new Headers(base)
  new Headers(extra).forEach((value, key) => { headers.set(key, value) })
  return headers
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/gif' || value === 'image/webp'
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new TypeError('MCP serverName must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/')
  }
}

function assertPositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`)
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('MCP value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

class McpOperationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpOperationTimeoutError'
  }
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController()
  const timeout = new McpOperationTimeoutError(message)
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
  let pending: Promise<T>
  try {
    pending = Promise.resolve(operation(controller.signal))
  } catch (error: unknown) {
    clearTimeout(timer)
    return Promise.reject(error)
  }
  return raceAbort(pending, controller.signal).finally(() => clearTimeout(timer))
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('MCP operation aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('MCP operation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
