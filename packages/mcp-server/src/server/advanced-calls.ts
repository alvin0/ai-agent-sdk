import type { AgentSession } from '@alvin0/ai-agent-sdk-core/agent'
import {
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { ContentBlock } from '@alvin0/ai-agent-sdk-core'
import { ToolCallId, isJsonValue, type JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { ToolCatalog } from '@alvin0/ai-agent-sdk-core/tools'
import {
  dispatchToolCall,
} from '@alvin0/ai-agent-sdk-core/tools'
import {
  beginIntegrationOperation,
  integrationErrorCode,
  type McpServerIntegrationFamily,
} from '../common/integration-operation.ts'
import { type PreferredServerAgent } from '../common/preferred-state.ts'
import type {
  SdkMcpRequestContext,
} from '../common/server-public-types.ts'
import type { SdkMcpServerOptions, McpAgentTool } from './advanced-types.ts'
import type { IntegrationAttempt, IntegrationOperation } from '../common/integration-operation.ts'
import { resolveLimits, serializedBytes, raceWithSignal, reportError, internalErrorMessage,
  type ResolvedMcpServerLimits ,
} from './advanced-support.ts'

type McpResultBlock = CallToolResult['content'][number]

export function serverFamily(options: SdkMcpServerOptions): McpServerIntegrationFamily {
  return options.integrationFamily ?? 'mcp-web-server'
}

export async function callRuntimeAgent(
  options: SdkMcpServerOptions,
  definition: { name: string; agent: PreferredServerAgent },
  args: { input: string },
  context: ServerContext,
): Promise<CallToolResult> {
  const { name, agent } = definition
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
    await reportError(options, limits, error, {
      operation: 'agent', exportName: name, requestId: String(context.mcpReq.id),
    })
    return errorResult(internalErrorMessage(options, error, 'agent operation failed'), 'AGENT_FAILED')
  }
}

export async function callSdkTool(
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
    const result = await dispatchSdkTool({ options, toolName, args, context, catalog, limits })
    if (serializedBytes(result) > limits.maxOutputBytes) {
      attempt.fail('OUTPUT_TOO_LARGE'); operation.fail('OUTPUT_TOO_LARGE')
      return errorResult(`tool result exceeds the ${limits.maxOutputBytes}-byte limit`, 'OUTPUT_TOO_LARGE')
    }
    return renderToolResult(result, { attempt, operation })
  } catch (error: unknown) {
    const code = integrationErrorCode(error)
    attempt.fail(code); operation.fail(code)
    await reportError(options, limits, error, {
      operation: 'tool', exportName: toolName, requestId: String(context.mcpReq.id),
    })
    return errorResult(internalErrorMessage(options, error, 'tool operation failed'), 'TOOL_OPERATION_FAILED')
  }
}

export async function callAgent(
  options: SdkMcpServerOptions,
  invocation: { definition: McpAgentTool; request: SdkMcpRequestContext },
  args: { input: string; conversationId?: string },
  context: ServerContext,
): Promise<CallToolResult> {
  const { definition, request } = invocation
  const limits = resolveLimits(options)
  const operation = beginIntegrationOperation(options.logger, serverFamily(options), 'agent-call')
  const attempt = operation.attempt(1)
  if (serializedBytes(args) > limits.maxInputBytes) {
    attempt.fail('INPUT_TOO_LARGE'); operation.fail('INPUT_TOO_LARGE')
    return errorResult(`agent input exceeds the ${limits.maxInputBytes}-byte limit`, 'INPUT_TOO_LARGE')
  }
  const signal = AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(limits.operationTimeoutMs)])
  try {
    const session = await createAgentSession({ definition, request, args, context, signal, limits })
    if (session.definition.id !== definition.agent.id) {
      attempt.fail('WRONG_AGENT_SESSION'); operation.fail('WRONG_AGENT_SESSION')
      return errorResult(
        `session factory for '${definition.name}' returned agent '${session.definition.id}', `
          + `expected '${definition.agent.id}'`,
        'WRONG_AGENT_SESSION',
      )
    }
    return await runAgentSession(session, args.input, { signal, limits, attempt, operation })
  } catch (error: unknown) {
    const code = integrationErrorCode(error)
    if (signal.aborted) { attempt.abort(); operation.abort() }
    else { attempt.fail(code); operation.fail(code) }
    await reportError(options, limits, error, {
      operation: 'agent', exportName: definition.name, requestId: String(context.mcpReq.id),
    })
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

function dispatchSdkTool(input: {
  options: SdkMcpServerOptions; toolName: string; args: Record<string, unknown>; context: ServerContext;
  catalog: ToolCatalog; limits: ResolvedMcpServerLimits;
}) {
  const { options, toolName, args, context, catalog, limits } = input
  return dispatchToolCall({
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
}

function renderToolResult(
  result: Awaited<ReturnType<typeof dispatchSdkTool>>,
  evidence: { attempt: IntegrationAttempt; operation: IntegrationOperation },
): CallToolResult {
  const { attempt, operation } = evidence
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
}

function createAgentSession(input: {
  definition: McpAgentTool; request: SdkMcpRequestContext; args: { conversationId?: string };
  context: ServerContext; signal: AbortSignal; limits: ResolvedMcpServerLimits;
}) {
  const { definition, request, args, context, signal, limits } = input
  const creating = Promise.resolve(definition.createSession({
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    request,
    call: context,
  }))
  return raceWithSignal(creating, signal, limits.teardownTimeoutMs)
}

async function runAgentSession(
  session: AgentSession, input: string,
  evidence: { signal: AbortSignal; limits: ResolvedMcpServerLimits;
    attempt: IntegrationAttempt; operation: IntegrationOperation },
): Promise<CallToolResult> {
  const { signal, limits, attempt, operation } = evidence
  const running = session.run(input, { signal })
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
}
