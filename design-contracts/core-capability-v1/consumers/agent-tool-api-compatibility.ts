import { ToolCallId, type ContentBlock, type JsonValue } from '@ai-agent-sdk/core'
import {
  TOOL_ERROR_CODES,
  TOOL_REGISTRY_ERROR_CODES,
  ToolError,
  ToolRegistry,
  authorizeToolCall,
  createApprovalBroker,
  defineTool,
  dispatchAuthorizedToolCall,
  dispatchToolCall,
  executionModeOf,
  finalizeToolCall,
  fixedApprovalBroker,
  prepareToolCall,
  renderJsonValue,
  toolErrorDisposition,
  toolFailure,
  type ApprovalBroker,
  type ApprovalRequest,
  type AuthorizationOutcome,
  type AuthorizedToolCall,
  type DispatchToolCallOptions,
  type InteractiveApprovalBroker,
  type InteractiveApprovalBrokerOptions,
  type PostToolDecision,
  type PreToolDecision,
  type PreparedToolCall,
  type ToolCallContext,
  type ToolCallPosition,
  type ToolCallRequest,
  type ToolCatalog,
  type ToolDefinition,
  type ToolErrorDisposition,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolFailure,
  type ToolFilter,
  type ToolInterceptor,
  type ToolRunContext,
  type ToolSuccess,
} from '@ai-agent-sdk/core/agent'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type AgentToolApiShape = [
  Assert<Equivalent<ToolExecutionMode, 'parallel' | 'exclusive'>>,
  Assert<Equivalent<ToolErrorDisposition, 'respond-to-model' | 'fatal'>>,
  Assert<Equivalent<ToolExecutionResult, ToolSuccess | ToolFailure>>,
]

export type AgentToolTypeInventory = [
  ApprovalBroker,
  ApprovalRequest,
  AuthorizationOutcome,
  AuthorizedToolCall,
  DispatchToolCallOptions,
  InteractiveApprovalBroker,
  InteractiveApprovalBrokerOptions,
  PostToolDecision,
  PreToolDecision,
  PreparedToolCall,
  ToolCallContext,
  ToolCallPosition,
  ToolCallRequest,
  ToolCatalog,
  ToolDefinition,
  ToolFilter,
  ToolInterceptor,
  ToolRunContext,
]

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo one JSON value.',
  parameters: { type: 'object' },
  parse(raw): JsonValue { return raw as JsonValue },
  execute(value, context) {
    context.addContext([{ type: 'text', text: 'context' }])
    return value
  },
  render(value): readonly ContentBlock[] { return renderJsonValue(value) },
})

const interceptor: ToolInterceptor = {
  name: 'compatibility',
  async before(_call, next): Promise<PreToolDecision> { return next() },
  async around(_call, next): Promise<ToolExecutionResult> { return next() },
  async after(_call, _result, next): Promise<PostToolDecision> { return next() },
}

/** Representative source compiled unchanged against current and target agent modules. */
export async function exerciseAgentToolApi(signal: AbortSignal): Promise<void> {
  const registry = new ToolRegistry()
  const dispose = registry.register(echoTool)
  const catalog: ToolCatalog = registry.view({ allow: ['echo'] })
  const call: ToolCallRequest = {
    callId: ToolCallId('call-1'),
    toolName: 'echo',
    rawArguments: '{}',
  }
  const options: DispatchToolCallOptions = {
    catalog,
    call,
    position: { turn: 1, step: 1 },
    signal,
    interceptors: [interceptor],
    approvals: fixedApprovalBroker('allow'),
  }
  const prepared = prepareToolCall(options)
  const authorized: AuthorizationOutcome = await authorizeToolCall(prepared)
  if (authorized.kind === 'authorized') {
    const executed = await dispatchAuthorizedToolCall(authorized.call)
    void await finalizeToolCall(authorized.call, executed)
  }
  void await dispatchToolCall(options)
  void executionModeOf(echoTool, {})
  void toolFailure('failed', TOOL_ERROR_CODES.FAILED)
  void toolErrorDisposition(ToolError.respondToModel('recoverable'))
  void TOOL_REGISTRY_ERROR_CODES.DUPLICATE_TOOL
  const interactive: InteractiveApprovalBroker = createApprovalBroker({ maxPending: 8 })
  interactive.abortAll()
  dispose()
}
