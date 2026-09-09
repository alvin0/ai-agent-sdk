/** Export SDK tools and agents as a Universal fetch-shaped MCP server. */

import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type CallToolResult,
  type CreateMcpHandlerOptions,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { ContentBlock } from '@alvin0/ai-agent-sdk-core'
import { ToolCallId, isJsonValue, type JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { AgentSession, DefinedAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ApprovalBroker, SdkLogger, ToolCatalog, ToolInterceptor } from '@alvin0/ai-agent-sdk-core/tools'
import {
  dispatchToolCall,
} from '@alvin0/ai-agent-sdk-core/tools'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import {
  beginIntegrationOperation,
  integrationChildLogger,
  integrationErrorCode,
  type McpServerIntegrationFamily,
} from '../common/integration-operation.ts'
import { copyPreferredState, preferredState, type PreferredServerAgent } from '../common/preferred-state.ts'
import { MCP_SERVER_DEFAULTS } from '../common/config.ts'
import type {
  SdkMcpCallContext,
  SdkMcpHandlerOptions,
  SdkMcpHandlerRequestOptions,
  SdkMcpHttpHandler,
  SdkMcpRequestContext,
  SdkMcpServer,
} from '../common/server-public-types.ts'

export type * from '../common/server-public-types.ts'

export interface McpAgentSessionContext {
  readonly conversationId?: string
  readonly request: SdkMcpRequestContext
  readonly call: SdkMcpCallContext
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
  readonly logger?: SdkLogger
  /** Internal family selected by the official Web/stdio host factory. */
  readonly integrationFamily?: 'mcp-web-server' | 'mcp-stdio-server'
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
  request: SdkMcpRequestContext = { era: 'modern' },
): SdkMcpServer {
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
  const runtimeAgents = Object.entries(preferredState(options)?.agents ?? {})
  if (schemas.length + (options.agents?.length ?? 0) + runtimeAgents.length > limits.maxExports) {
    throw new RangeError(`MCP server exceeds the ${limits.maxExports}-export limit`)
  }
  if (serializedBytes([schemas, options.agents?.map(agent => ({
    name: agent.name, description: agent.description, agentId: agent.agent.id,
  })) ?? [], runtimeAgents.map(([name]) => ({ name }))]) > limits.maxDefinitionBytes) {
    throw new RangeError(`MCP server definitions exceed the ${limits.maxDefinitionBytes}-byte limit`)
  }
  for (const schema of schemas) {
    if (names.has(schema.name)) throw new TypeError(`duplicate MCP export '${schema.name}'`)
    names.add(schema.name)
    server.registerTool(
      schema.name,
      {
        description: schema.description,
        // The Worker/browser validator dereferences by attaching private
        // metadata. SDK tool schemas are intentionally frozen, so give the
        // protocol boundary an isolated mutable copy.
        inputSchema: fromJsonSchema<Record<string, unknown>>(structuredClone(schema.parameters)),
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
  for (const [name, agent] of runtimeAgents) {
    assertIdentity(name, 'agent MCP tool name')
    if (names.has(name)) throw new TypeError(`duplicate MCP export '${name}'`)
    names.add(name)
    server.registerTool(name, {
      description: `Run the ${name} agent for one turn.`,
      inputSchema: fromJsonSchema<{ input: string }>({
        type: 'object', properties: { input: { type: 'string', minLength: 1 } },
        required: ['input'], additionalProperties: false,
      }),
    }, async (args, context) => await callRuntimeAgent(options, name, agent, args, context))
  }
  return server as unknown as SdkMcpServer
}

/**
 * Create a fetch-shaped API for Cloudflare Workers, Deno, Bun, Next.js route
 * handlers, or any web framework that accepts Request/Response.
 */
export function createSdkMcpHandler(
  options: SdkMcpServerOptions,
  handlerOptions?: SdkMcpHandlerOptions,
): SdkMcpHttpHandler {
  const handler = createMcpHandler(
    request => createSdkMcpServer(withRequestLogger(options), request as SdkMcpRequestContext) as unknown as McpServer,
    handlerOptions as CreateMcpHandlerOptions,
  )
  return {
    fetch: async (request: Request, requestOptions?: SdkMcpHandlerRequestOptions) => {
      const operation = beginIntegrationOperation(
        integrationChildLogger(options.logger, 'mcp-server-request'), serverFamily(options), 'request',
      )
      const attempt = operation.attempt(1)
      try {
        const response = await handler.fetch(request, requestOptions as never)
        if (response.status >= 500) {
          attempt.fail(`HTTP_${response.status}`); operation.fail(`HTTP_${response.status}`)
        } else {
          attempt.success(); operation.success()
        }
        return response
      } catch (error: unknown) {
        const code = integrationErrorCode(error)
        attempt.fail(code); operation.fail(code)
        throw error
      }
    },
    close: handler.close,
    notify: handler.notify,
    bus: handler.bus,
  } as unknown as SdkMcpHttpHandler
}

function withRequestLogger(options: SdkMcpServerOptions): SdkMcpServerOptions {
  const logger = integrationChildLogger(options.logger, 'mcp-server-request')
  if (logger === undefined) return options
  const child = { ...options, logger }
  copyPreferredState(options, child)
  return child
}

function serverFamily(options: SdkMcpServerOptions): McpServerIntegrationFamily {
  return options.integrationFamily ?? 'mcp-web-server'
}

async function callRuntimeAgent(
  options: SdkMcpServerOptions,
  name: string,
  agent: PreferredServerAgent,
  args: { input: string },
  context: ServerContext,
): Promise<CallToolResult> {
  const limits = resolveLimits(options)
  const operation = beginIntegrationOperation(options.logger, serverFamily(options), 'agent-call')
  const attempt = operation.attempt(1)
  if (serializedBytes(args) > limits.maxInputBytes) {
    attempt.fail('INPUT_TOO_LARGE'); operation.fail('INPUT_TOO_LARGE')
    return errorResult(`agent input exceeds the ${limits.maxInputBytes}-byte limit`, 'INPUT_TOO_LARGE')
  }
  const signal = AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(limits.operationTimeoutMs)])
  try {
    const response = await raceWithSignal(agent.generate(args.input, { signal }), signal, limits.teardownTimeoutMs)
    const result: CallToolResult = {
      content: [{ type: 'text', text: response.text || '(empty response)' }],
      structuredContent: { text: response.text, runId: response.runId, traceId: response.traceId },
    }
    if (serializedBytes(result) > limits.maxOutputBytes) {
      attempt.fail('OUTPUT_TOO_LARGE'); operation.fail('OUTPUT_TOO_LARGE')
      return errorResult(`agent result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    attempt.success(); operation.success()
    return result
  } catch (error: unknown) {
    const code = integrationErrorCode(error)
    if (signal.aborted) { attempt.abort(); operation.abort() }
    else { attempt.fail(code); operation.fail(code) }
    await reportError(options, limits, error, 'agent', name, context)
    return errorResult(internalErrorMessage(options, error, 'agent operation failed'), 'AGENT_FAILED')
  }
}

async function callSdkTool(
  options: SdkMcpServerOptions,
  toolName: string,
  args: Record<string, unknown>,
  context: ServerContext,
): Promise<CallToolResult> {
  const limits = resolveLimits(options)
  const operation = beginIntegrationOperation(options.logger, serverFamily(options), 'tool-call')
  const attempt = operation.attempt(1)
  if (serializedBytes(args) > limits.maxInputBytes) {
    attempt.fail('INPUT_TOO_LARGE'); operation.fail('INPUT_TOO_LARGE')
    return errorResult(`tool input exceeds the ${limits.maxInputBytes}-byte limit`, 'INPUT_TOO_LARGE')
  }
  const catalog = options.tools
  if (catalog === undefined) {
    attempt.fail('UNKNOWN_TOOL'); operation.fail('UNKNOWN_TOOL')
    return errorResult(`tool '${toolName}' is not available`, 'UNKNOWN_TOOL')
  }
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
      attempt.fail('OUTPUT_TOO_LARGE'); operation.fail('OUTPUT_TOO_LARGE')
      return errorResult(`tool result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    const content = [
      ...toMcpContent(result.content),
      ...toMcpContent(result.additionalContext ?? []),
    ]
    if (result.isError) {
      attempt.fail(result.error.code); operation.fail(result.error.code)
      return {
        isError: true,
        content: content.length === 0 ? [{ type: 'text', text: result.error.message }] : content,
        structuredContent: { error: result.error },
      }
    }
    attempt.success(); operation.success()
    return {
      content: content.length === 0 ? [{ type: 'text', text: '(no output)' }] : content,
      ...(result.value === undefined ? {} : { structuredContent: result.value }),
    }
  } catch (error: unknown) {
    const code = integrationErrorCode(error)
    attempt.fail(code); operation.fail(code)
    await reportError(options, limits, error, 'tool', toolName, context)
    return errorResult(internalErrorMessage(options, error, 'tool operation failed'), 'TOOL_OPERATION_FAILED')
  }
}

async function callAgent(
  options: SdkMcpServerOptions,
  definition: McpAgentTool,
  request: SdkMcpRequestContext,
  args: { input: string; conversationId?: string },
  context: ServerContext,
): Promise<CallToolResult> {
  const limits = resolveLimits(options)
  const operation = beginIntegrationOperation(options.logger, serverFamily(options), 'agent-call')
  const attempt = operation.attempt(1)
  if (serializedBytes(args) > limits.maxInputBytes) {
    attempt.fail('INPUT_TOO_LARGE'); operation.fail('INPUT_TOO_LARGE')
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
      attempt.fail('WRONG_AGENT_SESSION'); operation.fail('WRONG_AGENT_SESSION')
      return errorResult(
        `session factory for '${definition.name}' returned agent '${session.definition.id}', expected '${definition.agent.id}'`,
        'WRONG_AGENT_SESSION',
      )
    }
    const running = session.run(args.input, { signal })
    const response = await raceWithSignal(running, signal, limits.teardownTimeoutMs)
    if (!isJsonValue(response.outcome)) {
      attempt.fail('INVALID_AGENT_RESULT'); operation.fail('INVALID_AGENT_RESULT')
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
      attempt.fail('OUTPUT_TOO_LARGE'); operation.fail('OUTPUT_TOO_LARGE')
      return errorResult(`agent result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    attempt.success(); operation.success()
    return result
  } catch (error: unknown) {
    const code = integrationErrorCode(error)
    if (signal.aborted) { attempt.abort(); operation.abort() }
    else { attempt.fail(code); operation.fail(code) }
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
    maxExports: positiveSafeInteger(options.maxExports ?? MCP_SERVER_DEFAULTS.maxExports, 'maxExports'),
    maxDefinitionBytes: positiveSafeInteger(
      options.maxDefinitionBytes ?? MCP_SERVER_DEFAULTS.maxDefinitionBytes, 'maxDefinitionBytes',
    ),
    maxInputBytes: positiveSafeInteger(options.maxInputBytes ?? MCP_SERVER_DEFAULTS.maxInputBytes, 'maxInputBytes'),
    maxOutputBytes: positiveSafeInteger(options.maxOutputBytes ?? MCP_SERVER_DEFAULTS.maxOutputBytes, 'maxOutputBytes'),
    operationTimeoutMs: positiveSafeInteger(
      options.operationTimeoutMs ?? MCP_SERVER_DEFAULTS.operationTimeoutMs, 'operationTimeoutMs',
    ),
    teardownTimeoutMs: positiveSafeInteger(
      options.teardownTimeoutMs ?? MCP_SERVER_DEFAULTS.teardownTimeoutMs, 'teardownTimeoutMs',
    ),
    observerTimeoutMs: positiveSafeInteger(
      options.observerTimeoutMs ?? MCP_SERVER_DEFAULTS.observerTimeoutMs, 'observerTimeoutMs',
    ),
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
