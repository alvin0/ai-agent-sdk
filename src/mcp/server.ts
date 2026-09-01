/** Export SDK tools and agents as a web-standard MCP server. */

import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type CallToolResult,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type McpRequestContext,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { ContentBlock } from '../core/message/content.ts'
import { ToolCallId } from '../core/primitives/brand.ts'
import { isJsonValue, type JsonValue } from '../core/primitives/json.ts'
import type { DefinedAgent } from '../agent/define/definition.ts'
import type { AgentSession } from '../agent/define/session.ts'
import type { ApprovalBroker } from '../agent/tool/approval.ts'
import { dispatchToolCall, type ToolInterceptor } from '../agent/tool/pipeline.ts'
import type { ToolCatalog } from '../agent/tool/registry.ts'
import { waitForSettlement } from '../core/async/settlement.ts'

export interface McpAgentSessionContext {
  readonly conversationId?: string
  readonly request: McpRequestContext
  readonly call: ServerContext
}

export interface McpAgentTool {
  readonly name: string
  readonly description?: string
  readonly agent: DefinedAgent
  /** Host-owned persistence seam: return a fresh or resumed session. */
  readonly createSession: (context: McpAgentSessionContext) => AgentSession | Promise<AgentSession>
}

export interface McpServerErrorContext {
  readonly operation: 'tool' | 'agent'
  readonly exportName: string
  readonly requestId: string
}

export interface SdkMcpServerOptions {
  readonly name: string
  readonly version: string
  readonly instructions?: string
  /** SDK tools exposed through the existing validation/policy pipeline. */
  readonly tools?: ToolCatalog
  readonly agents?: readonly McpAgentTool[]
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  /** Maximum exported tools and agents. Defaults to 1,024. */
  readonly maxExports?: number
  /** Maximum serialized export schema bytes. Defaults to 4 MiB. */
  readonly maxDefinitionBytes?: number
  /** Maximum serialized request arguments. Defaults to 1 MiB. */
  readonly maxInputBytes?: number
  /** Maximum serialized tool/agent result. Defaults to 4 MiB. */
  readonly maxOutputBytes?: number
  /** Default tool/agent operation deadline. Defaults to 10 minutes. */
  readonly operationTimeoutMs?: number
  /** Maximum wait after cancellation. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  /** Maximum time granted to the diagnostic observer. Defaults to 5 seconds. */
  readonly observerTimeoutMs?: number
  /** Report host/runtime failures without giving the observer control over request completion. */
  readonly onError?: (error: unknown, context: McpServerErrorContext) => void | Promise<void>
  /** Opt in to returning internal exception messages to remote callers. Defaults to false. */
  readonly exposeInternalErrors?: boolean
}

type McpResultBlock = CallToolResult['content'][number]

/** Create one MCP server instance for a connection or HTTP request. */
export function createSdkMcpServer(
  options: SdkMcpServerOptions,
  request: McpRequestContext = { era: 'modern' },
): McpServer {
  const limits = resolveLimits(options)
  assertIdentity(options.name, 'server name')
  if (options.version.trim().length === 0) throw new TypeError('MCP server version must not be empty')
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
  )
  const names = new Set<string>()
  const schemas = options.tools?.schemas() ?? []
  if (schemas.length + (options.agents?.length ?? 0) > limits.maxExports) {
    throw new RangeError(`MCP server exceeds the ${limits.maxExports}-export limit`)
  }
  if (serializedBytes([schemas, options.agents?.map(agent => ({
    name: agent.name, description: agent.description, agentId: agent.agent.id,
  })) ?? []]) > limits.maxDefinitionBytes) {
    throw new RangeError(`MCP server definitions exceed the ${limits.maxDefinitionBytes}-byte limit`)
  }
  for (const schema of schemas) {
    if (names.has(schema.name)) throw new TypeError(`duplicate MCP export '${schema.name}'`)
    names.add(schema.name)
    server.registerTool(
      schema.name,
      {
        description: schema.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(schema.parameters),
      },
      async (args, context) => await callSdkTool(options, schema.name, args, context),
    )
  }
  for (const agent of options.agents ?? []) {
    assertIdentity(agent.name, 'agent MCP tool name')
    if (names.has(agent.name)) throw new TypeError(`duplicate MCP export '${agent.name}'`)
    names.add(agent.name)
    server.registerTool(
      agent.name,
      {
        description: agent.description
          ?? agent.agent.description
          ?? `Run the ${agent.agent.name} agent for one conversational turn.`,
        inputSchema: fromJsonSchema<{ input: string; conversationId?: string }>({
          type: 'object',
          properties: {
            input: { type: 'string', minLength: 1 },
            conversationId: { type: 'string', minLength: 1 },
          },
          required: ['input'],
          additionalProperties: false,
        }),
      },
      async (args, context) => await callAgent(options, agent, request, args, context),
    )
  }
  return server
}

/**
 * Create a fetch-shaped API for Cloudflare Workers, Deno, Bun, Next.js route
 * handlers, or any web framework that accepts Request/Response.
 */
export function createSdkMcpHandler(
  options: SdkMcpServerOptions,
  handlerOptions?: CreateMcpHandlerOptions,
): McpHttpHandler {
  return createMcpHandler(request => createSdkMcpServer(options, request), handlerOptions)
}

async function callSdkTool(
  options: SdkMcpServerOptions,
  toolName: string,
  args: Record<string, unknown>,
  context: ServerContext,
): Promise<CallToolResult> {
  const limits = resolveLimits(options)
  if (serializedBytes(args) > limits.maxInputBytes) {
    return errorResult(`tool input exceeds the ${limits.maxInputBytes}-byte limit`, 'INPUT_TOO_LARGE')
  }
  const catalog = options.tools
  if (catalog === undefined) return errorResult(`tool '${toolName}' is not available`, 'UNKNOWN_TOOL')
  try {
    const result = await dispatchToolCall({
      catalog,
      call: {
        callId: ToolCallId(`mcp:${String(context.mcpReq.id)}`),
        toolName,
        rawArguments: JSON.stringify(args),
      },
      position: { turn: 1, step: 1 },
      signal: AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(limits.operationTimeoutMs)]),
      defaultTimeoutMs: limits.operationTimeoutMs,
      teardownTimeoutMs: limits.teardownTimeoutMs,
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
    })
    if (serializedBytes(result) > limits.maxOutputBytes) {
      return errorResult(`tool result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    const content = [
      ...toMcpContent(result.content),
      ...toMcpContent(result.additionalContext ?? []),
    ]
    if (result.isError) {
      return {
        isError: true,
        content: content.length === 0 ? [{ type: 'text', text: result.error.message }] : content,
        structuredContent: { error: result.error },
      }
    }
    return {
      content: content.length === 0 ? [{ type: 'text', text: '(no output)' }] : content,
      ...(result.value === undefined ? {} : { structuredContent: result.value }),
    }
  } catch (error: unknown) {
    await reportError(options, limits, error, 'tool', toolName, context)
    return errorResult(internalErrorMessage(options, error, 'tool operation failed'), 'TOOL_OPERATION_FAILED')
  }
}

async function callAgent(
  options: SdkMcpServerOptions,
  definition: McpAgentTool,
  request: McpRequestContext,
  args: { input: string; conversationId?: string },
  context: ServerContext,
): Promise<CallToolResult> {
  const limits = resolveLimits(options)
  if (serializedBytes(args) > limits.maxInputBytes) {
    return errorResult(`agent input exceeds the ${limits.maxInputBytes}-byte limit`, 'INPUT_TOO_LARGE')
  }
  const signal = AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(limits.operationTimeoutMs)])
  try {
    const creating = Promise.resolve(definition.createSession({
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      request,
      call: context,
    }))
    const session = await raceWithSignal(creating, signal, limits.teardownTimeoutMs)
    if (session.definition.id !== definition.agent.id) {
      return errorResult(
        `session factory for '${definition.name}' returned agent '${session.definition.id}', expected '${definition.agent.id}'`,
        'WRONG_AGENT_SESSION',
      )
    }
    const running = session.run(args.input, { signal })
    const response = await raceWithSignal(running, signal, limits.teardownTimeoutMs)
    if (!isJsonValue(response.outcome)) {
      return errorResult('agent outcome was not lossless JSON', 'INVALID_AGENT_RESULT')
    }
    const result: CallToolResult = {
      content: [{ type: 'text', text: response.text || '(empty response)' }],
      structuredContent: {
        text: response.text,
        outcome: response.outcome,
        conversationId: session.conversationId,
      },
    }
    if (serializedBytes(result) > limits.maxOutputBytes) {
      return errorResult(`agent result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    return result
  } catch (error: unknown) {
    await reportError(options, limits, error, 'agent', definition.name, context)
    return errorResult(internalErrorMessage(options, error, 'agent operation failed'), 'AGENT_FAILED')
  }
}

function toMcpContent(blocks: readonly ContentBlock[]): McpResultBlock[] {
  const result: McpResultBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image' && block.source.kind === 'base64') {
      result.push({
        type: 'image',
        data: block.source.data,
        mimeType: block.source.mediaType,
      })
      continue
    }
    if (block.type === 'image' && block.source.kind === 'url') {
      result.push({ type: 'text', text: `[image](${block.source.url})` })
      continue
    }
    if (block.type === 'image' && block.source.kind === 'file') {
      result.push({ type: 'text', text: `[image file: ${block.source.fileId}]` })
      continue
    }
    if (block.type === 'reasoning') {
      result.push({ type: 'text', text: block.text })
      continue
    }
    result.push({ type: 'text', text: JSON.stringify(jsonSafeBlock(block)) })
  }
  return result
}

function jsonSafeBlock(block: ContentBlock): JsonValue {
  if (isJsonValue(block)) return block
  return { type: block.type }
}

function errorResult(message: string, code: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: { error: { message, code } },
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be empty`)
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message.length > 0 ? value.message : String(value)
}

interface ResolvedMcpServerLimits {
  readonly maxExports: number
  readonly maxDefinitionBytes: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly operationTimeoutMs: number
  readonly teardownTimeoutMs: number
  readonly observerTimeoutMs: number
}

function resolveLimits(options: SdkMcpServerOptions): ResolvedMcpServerLimits {
  return {
    maxExports: positiveSafeInteger(options.maxExports ?? 1_024, 'maxExports'),
    maxDefinitionBytes: positiveSafeInteger(options.maxDefinitionBytes ?? 4 * 1024 * 1024, 'maxDefinitionBytes'),
    maxInputBytes: positiveSafeInteger(options.maxInputBytes ?? 1024 * 1024, 'maxInputBytes'),
    maxOutputBytes: positiveSafeInteger(options.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes'),
    operationTimeoutMs: positiveSafeInteger(options.operationTimeoutMs ?? 10 * 60_000, 'operationTimeoutMs'),
    teardownTimeoutMs: positiveSafeInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs'),
    observerTimeoutMs: positiveSafeInteger(options.observerTimeoutMs ?? 5_000, 'observerTimeoutMs'),
  }
}

async function reportError(
  options: SdkMcpServerOptions,
  limits: ResolvedMcpServerLimits,
  error: unknown,
  operation: McpServerErrorContext['operation'],
  exportName: string,
  context: ServerContext,
): Promise<void> {
  if (options.onError === undefined) return
  const pending = Promise.resolve().then(() => options.onError?.(error, Object.freeze({
    operation,
    exportName,
    requestId: String(context.mcpReq.id),
  })))
  await waitForSettlement(pending, limits.observerTimeoutMs)
}

function internalErrorMessage(options: SdkMcpServerOptions, error: unknown, fallback: string): string {
  return options.exposeInternalErrors === true ? errorMessage(error) : fallback
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`MCP server ${label} must be a positive safe integer`)
  return value
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('MCP server value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

async function raceWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  teardownTimeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('MCP server operation aborted')
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort)
        reject(signal.reason ?? new Error('MCP server operation aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void pending.then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
    })
  } catch (error: unknown) {
    if (signal.aborted) await waitForSettlement(pending, teardownTimeoutMs)
    throw error
  }
}
