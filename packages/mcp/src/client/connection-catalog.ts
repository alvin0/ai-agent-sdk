import { bridgeRemoteTool } from './tool-bridge.ts'
import { Client, type Tool } from '@modelcontextprotocol/client'
import type { JsonValue } from '@alvin0/ai-agent-sdk-core'
import { ToolRegistry, type ToolDefinition } from '@alvin0/ai-agent-sdk-core/tools'
import { beginIntegrationOperation, integrationErrorCode } from '../common/integration-operation.ts'
import { filterRemoteTools, publicToolName, serializedBytes, withAbortTimeout } from './runtime-helpers.ts'
import type { McpConnectionHost } from './connection-host.ts'
import { handleToolAuthorization } from './connection-authorization.ts'

export function enqueueToolSync(host: McpConnectionHost,
  generation: Client,
  supplied?: readonly Tool[],
  callerSignal?: AbortSignal,
): Promise<void> {
  host.pendingToolSyncs += 1
  const run = host.syncTail.then(async () => {
    if (host.closed || host.current !== generation) return
    const operation = beginIntegrationOperation(host.options.logger, host.integrationFamily, 'catalog-refresh')
    const attempt = operation.attempt(1)
    try {
      const tools = supplied ?? (await withAbortTimeout(
        signal => generation.listTools(undefined, { cacheMode: 'refresh', signal }),
        host.operationTimeoutMs,
        `MCP tool discovery exceeded ${host.operationTimeoutMs}ms`,
        callerSignal,
      )).tools
      if (host.closed || host.current !== generation) {
        attempt.abort(); operation.abort(); return
      }
      swapTools(host, tools)
      attempt.success(); operation.success()
    } catch (error: unknown) {
      attempt.fail(integrationErrorCode(error)); operation.fail(integrationErrorCode(error))
      throw error
    }
  })
  const tracked = run.finally(() => { host.pendingToolSyncs -= 1 })
  host.syncTail = tracked.catch(() => undefined)
  return tracked
}

export function swapTools(
  host: McpConnectionHost, remoteTools: readonly Tool[]): void {
  if (remoteTools.length > host.maxTools) {
    throw new RangeError(`MCP server '${host.serverName}' exceeds the ${host.maxTools}-tool limit`)
  }
  if (serializedBytes(remoteTools) > host.maxCatalogBytes) {
    throw new RangeError(`MCP server '${host.serverName}' catalog exceeds the ${host.maxCatalogBytes}-byte limit`)
  }
  const next = new ToolRegistry()
  const seen = new Set<string>()
  for (const remote of filterRemoteTools(remoteTools, host.options.toolFilter)) {
    const name = publicToolName(host.serverName, remote.name, host.options.prefixToolNames !== false)
    if (seen.has(name)) throw new Error(`MCP server '${host.serverName}' produced duplicate tool name '${name}'`)
    seen.add(name)
    next.register(bridgeTool(host, name, remote))
  }
  clearTools(host, false)
  host.toolDisposers = next.names().map(name => host.registry.register(next.get(name) as ToolDefinition))
  bumpCatalogRevision(host)
}

export function bridgeTool(
  host: McpConnectionHost, publicName: string, remote: Tool): ToolDefinition<Record<string, JsonValue>> {
  return bridgeRemoteTool({
    serverName: host.serverName, toolCallTimeoutMs: host.toolCallTimeoutMs,
    maxToolResultBytes: host.maxToolResultBytes, integrationFamily: host.integrationFamily,
    trustReadOnlyAnnotations: host.options.trustReadOnlyAnnotations,
    generation: () => host.current,
    authorizationFailure: (generation, error) => handleToolAuthorization(host, generation, error),
  }, publicName, remote)
}

export function clearTools(
  host: McpConnectionHost, recordRevision = true): void {
  if (host.toolDisposers.length === 0) return
  for (const dispose of host.toolDisposers) dispose()
  host.toolDisposers = []
  if (recordRevision) bumpCatalogRevision(host)
}

export function bumpCatalogRevision(host: McpConnectionHost): void {
  if (host.catalogRevision < Number.MAX_SAFE_INTEGER) host.catalogRevision += 1
  host.currentState = Object.freeze({ ...host.currentState, catalogRevision: host.catalogRevision })
  try { host.options.onStateChange?.(host.currentState) } catch { /* observers do not own state */ }
}
