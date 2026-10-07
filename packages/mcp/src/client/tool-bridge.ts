import { type Client, type Tool } from '@modelcontextprotocol/client'
import type { JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { ToolDefinition } from '@alvin0/ai-agent-sdk-core/tools'
import { beginIntegrationOperation, integrationErrorCode, type McpIntegrationFamily }
  from '../common/integration-operation.ts'
import { McpRemoteToolError, normalizeResult, renderMcpResult } from './result.ts'
import { isJsonObject, serializedBytes, raceAbort } from './runtime-helpers.ts'

interface RemoteToolOwner {
  readonly serverName: string
  readonly toolCallTimeoutMs: number
  readonly maxToolResultBytes: number
  readonly integrationFamily: McpIntegrationFamily
  readonly trustReadOnlyAnnotations: boolean | undefined
  generation(): Client | undefined
  authorizationFailure(generation: Client, error: unknown): Promise<void>
}

export function bridgeRemoteTool(
  owner: RemoteToolOwner, publicName: string, remote: Tool,
): ToolDefinition<Record<string, JsonValue>> {
  const inputSchema = isJsonObject(remote.inputSchema)
    ? structuredClone(remote.inputSchema)
    : { type: 'object', additionalProperties: true }
  return {
    name: publicName,
    description: remote.description?.trim() || `Tool '${remote.name}' from MCP server '${owner.serverName}'.`,
    parameters: inputSchema,
    // The bridge returns `{ content, structuredContent }`; a declared output
    // schema describes the structured half. Programs validate against it.
    ...isJsonObject(remote.outputSchema) ? {
      experimentalOutputSchema: {
        type: 'object',
        properties: { structuredContent: structuredClone(remote.outputSchema) },
        required: ['structuredContent'],
      },
    } : {},
    timeoutMs: owner.toolCallTimeoutMs,
    parse: raw => {
      if (!isJsonObject(raw)) throw new TypeError('MCP tool arguments must be a JSON object')
      return raw
    },
    execute: (args, context) => executeRemoteTool(owner, remote, args, context),
    render: value => renderMcpResult(value),
    meta: () => ({ kind: 'mcp', serverName: owner.serverName, remoteToolName: remote.name }),
    ...(owner.trustReadOnlyAnnotations === true && remote.annotations?.readOnlyHint === true
      ? { isConcurrencySafe: () => true }
      : {}),
  }
}

type RemoteToolContext = Parameters<ToolDefinition<Record<string, JsonValue>>['execute']>[1]

async function executeRemoteTool(
  owner: RemoteToolOwner, remote: Tool, args: Record<string, JsonValue>, context: RemoteToolContext,
) {
  const generation = owner.generation()
  if (generation === undefined) throw new Error(`MCP server '${owner.serverName}' is not connected`)
  const operation = beginIntegrationOperation(context.logger, owner.integrationFamily, 'tool-call')
  const attempt = operation.attempt(1)
  try {
    const result = await raceAbort(generation.callTool(
      { name: remote.name, arguments: args },
      {
        signal: context.signal,
        toolDefinition: remote,
        timeout: owner.toolCallTimeoutMs,
      },
    ), context.signal)
    if (serializedBytes(result) > owner.maxToolResultBytes) {
      throw new RangeError(
        `MCP tool '${owner.serverName}/${remote.name}' result exceeds the ${owner.maxToolResultBytes}-byte limit`,
      )
    }
    if (result.isError === true) throw new McpRemoteToolError(owner.serverName, remote.name, result)
    const normalized = normalizeResult(result)
    attempt.success(); operation.success()
    return normalized
  } catch (error: unknown) {
    if (context.signal.aborted) {
      attempt.abort(); operation.abort()
    } else {
      attempt.fail(integrationErrorCode(error)); operation.fail(integrationErrorCode(error))
    }
    await owner.authorizationFailure(generation, error)
    throw error
  }
}
