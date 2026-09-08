/** The tool layer: what a tool is, where tools live, and how failures are classed. */

export {
  defineTool,
  executionModeOf,
  renderJsonValue,
  type ToolCallPosition,
  type ToolDefinition,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolFailure,
  type ToolRunContext,
  type ToolSuccess,
} from './definition.ts'
export {
  TOOL_ERROR_CODES,
  ToolError,
  toolErrorDisposition,
  type ToolErrorDisposition,
} from './errors.ts'
export {
  REGISTRY_ERROR_CODES as TOOL_REGISTRY_ERROR_CODES,
  ToolRegistry,
  type ToolCatalog,
  type ToolFilter,
} from './registry.ts'
export {
  createApprovalBroker,
  fixedApprovalBroker,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type InteractiveApprovalBroker,
  type InteractiveApprovalBrokerOptions,
} from './approval.ts'
export {
  authorizeToolCall,
  dispatchAuthorizedToolCall,
  dispatchToolCall,
  finalizeToolCall,
  prepareToolCall,
  toolFailure,
  type AuthorizationOutcome,
  type AuthorizedToolCall,
  type DispatchToolCallOptions,
  type PostToolDecision,
  type PreToolDecision,
  type ToolCallContext,
  type ToolCallRequest,
  type ToolInterceptor,
  type PreparedToolCall,
} from './pipeline.ts'
export {
  createMemorySpillStore,
  estimateTextBlockTokens,
  estimateTextTokens,
  previewForSpill,
  readSpillTool,
  truncateMiddleToTokens,
  SPILL_TOOL_NAME,
  type MemorySpillStoreLimits,
  type SpillRecord,
  type SpillSlice,
  type SpillStore,
  type ToolOutputOverflowPolicy,
  type TruncatedText,
} from './output-budget.ts'
