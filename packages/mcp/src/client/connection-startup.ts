import { handleConnectAuthorization, logAuthenticationSuccess } from './connection-authorization.ts'
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
import type { McpTransportFactory, McpTransportKind } from './api-types.ts'
import { protocolState } from './result.ts'
import { beginIntegrationOperation, integrationErrorCode } from '../common/integration-operation.ts'
import { mcpSupportError } from '../common/support-error.ts'
import { errorOf, withAbortTimeout } from './runtime-helpers.ts'
import type { McpConnectionHost } from './connection-host.ts'
import { enqueueToolSync } from './connection-catalog.ts'

function transportKindOf(transport: Transport): McpTransportKind {
  if (transport instanceof StreamableHTTPClientTransport) return 'streamable-http'
  if (transport instanceof SSEClientTransport) return 'sse'
  return 'custom'
}

function shouldTryLegacyTransport(error: unknown): boolean {
  if (UnauthorizedError.isInstance(error) || InsufficientScopeError.isInstance(error)) return false
  return !(error instanceof Error && error.name === 'AbortError')
}

export async function connectGeneration(
  host: McpConnectionHost, reconnecting: boolean): Promise<void> {
  const attempt = reconnecting ? host.reconnectAttempts : 0
  const operation = beginIntegrationOperation(
    host.options.logger,
    host.integrationFamily,
    reconnecting ? 'reconnect' : 'connect',
  )
  host.publish(reconnecting ? 'reconnecting' : 'connecting', attempt)
  const factories = [host.transportFactory, host.fallbackTransportFactory]
    .filter((factory): factory is McpTransportFactory => factory !== undefined)
  let lastFailure: Error | undefined

  for (let index = 0; index < factories.length; index++) {
    const physicalAttempt = operation.attempt(index + 1)
    const generation = createAttemptGeneration(host, physicalAttempt, operation)
    let starting = true
    let transport: Transport | undefined
    host.current = generation
    generation.onclose = () => {
      if (!starting) host.generationDown(generation)
    }
    try {
      const openedTransport = (factories[index] as McpTransportFactory)() as unknown as Transport
      transport = openedTransport
      await startGeneration(host, generation, openedTransport, { index, started: () => { starting = false } })
      physicalAttempt.success()
      operation.success()
      logAuthenticationSuccess(host)
      return
    } catch (error: unknown) {
      physicalAttempt.fail(integrationErrorCode(error))
      starting = false
      const failure = errorOf(error)
      lastFailure = failure
      if (host.current === generation) host.current = undefined

      await handleConnectAuthorization(host, generation, transport, { error, failure, operation })

      if (await finishConnectionFailure(host, generation, error, {
        hasFallback: index + 1 < factories.length, failure, operation,
      })) continue
    }
  }
  failUnavailableTransport(host, lastFailure, operation)
}

export function failUnavailableTransport(host: McpConnectionHost,
  lastFailure: Error | undefined, operation: ReturnType<typeof beginIntegrationOperation>,
): never {
  const failure = lastFailure ?? new Error(`MCP connection '${host.serverName}' has no transport candidate`)
  reconnectAfterFailure(host, failure)
  operation.fail(integrationErrorCode(failure))
  throw failure
}

export async function finishConnectionFailure(
  host: McpConnectionHost, generation: Client, error: unknown, context: {
  hasFallback: boolean; failure: Error; operation: ReturnType<typeof beginIntegrationOperation>
}): Promise<boolean> {
  const { hasFallback, failure, operation } = context
      await host.closeGeneration(generation)
      const canFallback = hasFallback && shouldTryLegacyTransport(error)
      if (canFallback) return true
      reconnectAfterFailure(host, failure)
      operation.fail(integrationErrorCode(error))
      throw failure
}

export async function startGeneration(host: McpConnectionHost,
  generation: Client, transport: Transport, startup: { index: number; started: () => void },
): Promise<void> {
  const { index, started } = startup
  await withAbortTimeout(
    () => generation.connect(transport),
    host.operationTimeoutMs,
    `MCP connection '${host.serverName}' exceeded ${host.operationTimeoutMs}ms`,
    host.options.signal,
  )
  if (host.current !== generation || host.closed)
    throw new Error(`MCP connection '${host.serverName}' closed during startup`)
  await enqueueToolSync(host, generation, undefined, host.options.signal)
  if (host.current !== generation || host.closed)
    throw new Error(`MCP connection '${host.serverName}' closed during tool discovery`)
  host.connectedAt = Date.now()
  started()
  host.publish('ready', host.reconnectAttempts, undefined, {
    protocol: protocolState(generation, transportKindOf(transport), index > 0),
  })
}

export function createAttemptGeneration(host: McpConnectionHost,
  physicalAttempt: ReturnType<ReturnType<typeof beginIntegrationOperation>['attempt']>,
  operation: ReturnType<typeof beginIntegrationOperation>,
): Client {
    try { return createGeneration(host) }
    catch (error: unknown) {
      const code = integrationErrorCode(error)
      physicalAttempt.fail(code); operation.fail(code)
      throw error
    }
}

export function reconnectAfterFailure(
  host: McpConnectionHost, failure: Error): void {
  if (!host.closed) host.scheduleReconnect(failure)
}

export function createGeneration(host: McpConnectionHost): Client {
  let generation!: Client
  generation = new Client(
    {
      name: host.options.clientName ?? 'ai-agent-sdk',
      version: host.options.clientVersion ?? '0.0.0',
    },
    clientOptions(host, (error, items) => {
      if (host.current !== generation || host.closed) return
      if (error !== null || items === null) {
        try {
          host.options.onStateChange?.(Object.freeze({
            ...host.currentState,
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
      void enqueueToolSync(host, generation, items).catch(error => {
        try {
          host.options.onStateChange?.(Object.freeze({
            ...host.currentState,
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

export function clientOptions(
  host: McpConnectionHost, onToolsChanged: (error: Error | null, tools: Tool[] | null) => void): ClientOptions {
  return {
    capabilities: {},
    versionNegotiation: { mode: host.options.protocol ?? 'auto' },
    listChanged: {
      tools: { autoRefresh: true, onChanged: onToolsChanged },
    },
  }
}

