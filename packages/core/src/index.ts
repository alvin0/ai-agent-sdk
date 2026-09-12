/**
 * The provider-neutral core. Adapters are the only layer that knows a provider's
 * wire format; everything else in this package speaks what is exported here.
 *
 * Read the folders in dependency order to understand the design:
 *
 * - `primitives/` — branded ids, deep freeze, exhaustiveness. No dependencies.
 * - `async/`      — inward bounded-settlement primitives shared by outer layers.
 * - `observation/` — Web-standard correlation, usage, and telemetry ports.
 * - `plugin/`      — transactional provider extension contracts.
 * - `errors/`     — the `code`-routed taxonomy and its serializable twin.
 * - `message/`    — content blocks, immutable messages, content projection.
 * - `stream/`     — the chunk protocol, its assembler, SSE and idle bounds.
 * - `contract/`   — what an adapter implements and what it receives.
 * - `runtime/`    — the registry that routes calls, and retry.
 * - `http/`       — credential and attribution concerns adapters share.
 *
 * @module ai-agent-sdk/core
 */

export * from './primitives/index.ts'
export * from './async/index.ts'
export * from './observation/index.ts'
// Compatibility debt: low-level registry/plugin assembly remains at root only
// under the frozen API ledger. Removal needs a separately approved breaking
// decision and a checked consumer migration; normal applications use AgentRuntime.
export * from './plugin/index.ts'
export * from './errors/index.ts'
export * from './message/index.ts'
export * from './stream/index.ts'
export * from './contract/index.ts'
export * from './runtime/index.ts'
export * from './http/index.ts'
export * from './memory.ts'
export * from './skills.ts'
export { createAgentRuntime } from './composition/runtime/public.ts'
export { defineAgent, cloneAgent } from './composition/agent/author.ts'
export type {
  AgentDefinition, AgentDefinitionInput, AgentDefinitionOverrides,
  CloneAgentOverrides, DefinedAgent,
} from './agent/define/definition.ts'
export type {
  AgentRuntime, AgentRuntimeOptions, DiagnosticSnapshot, RuntimeCloseReport,
  RuntimeObservationResourceInput, RuntimeOwnerObservabilityOptions,
} from './composition/runtime/types.ts'
export type {
  RuntimeAgent, RuntimeAgentBindingInput, RuntimeAgentDefinition, RuntimeAgentDefinitionInput,
  RuntimeAgentInvocationOptions, RuntimeAgentLimits, RuntimeAgentResponse,
  RuntimeAgentRunEvent, RuntimeAgentRunEventContext, RuntimeAgentRunHandle, RuntimeAgentSession,
  RuntimeAgentSessionOptions, RuntimeAgentSessionSnapshot,
} from './composition/agent/types.ts'
export type { RuntimeProviderInfo } from './composition/provider/types.ts'
export type { RuntimeModelCatalogSnapshot } from './composition/model-catalog/types.ts'
export type {
  AgentTeamMemberInput, RuntimeAgentTeam, RuntimeAgentTeamEvent, RuntimeAgentTeamOptions,
} from './composition/team/types.ts'
export type { SupportSafeError } from './support-safe/error.ts'
export type { CapabilityIdentityConflict } from './composition/common/errors.ts'
export type {
  ObservationDeliveryAck, ObservationDeliveryBatch, ObservationExportItem,
  RunReport, RunTerminalRecord,
} from './composition/exporter/delivery-types.ts'
export { defineObservationExporter } from './composition/exporter/definition.ts'
export { OBSERVATION_EXPORTER_API_VERSION } from './composition/exporter/types.ts'
export type {
  ObservationExporterPlugin, ObservationExporterPluginDefinition,
  RuntimeObservationExporterRegistration,
} from './composition/exporter/types.ts'
export type { LogLevel, SdkLogger } from './observability/types.ts'
// Embedding: root carries ONLY the type surface of `AgentRuntime.embeddingModel()`,
// because that method is declared here. The rest of `Embedding_Contract` — adapter,
// batch request/result, profile, catalog, limits, errors, validation — is reached
// through the `./embedding` entry point.
export type {
  EmbeddingManyResult, EmbeddingModelHandle, EmbeddingModelOptions, EmbeddingResult,
  EmbeddingUsageReport,
} from './embedding/index.ts'
export { defineTool } from './agent/tool/definition.ts'
export type { ToolDefinition, ToolRunContext } from './agent/tool/definition.ts'
export { createApprovalRequest, createApprovalBroker, fixedApprovalBroker } from './agent/tool/approval.ts'
export type {
  ApprovalBroker, ApprovalDecision, ApprovalRequest,
  InteractiveApprovalBroker, InteractiveApprovalBrokerOptions,
} from './agent/tool/approval.ts'
export { createUserInputBroker, fixedUserInputBroker } from './agent/mode/user-input.ts'
export type {
  InteractiveUserInputBroker, InteractiveUserInputBrokerOptions,
  UserInputAnswer, UserInputBroker, UserInputDecision, UserInputOption,
  UserInputQuestion, UserInputRequest, UserInputResponse,
} from './agent/mode/user-input.ts'

export { defineToolFromSchema, type RuntimeSchema } from './agent/tool/schema.ts'

export { createToolExecutionInterceptor, localToolExecutionBackend, type ToolExecutionBackend, type ToolExecutionCapabilities, type ToolExecutionRequest, type ToolExecutionStore, type ToolOperation, type ToolOperationClaim } from './agent/tool/execution.ts'

export { withApprovalPersistence, type ApprovalStateStore } from './agent/tool/approval.ts'

export type { AgentInput } from './agent/define/session/types.ts'

export {
  CONTEXT_SECTION_ID_PATTERN, CONTEXT_SECTION_INVALID, MAX_CONTEXT_SECTION_TEXT_BYTES,
  defineContextSection,
} from './agent/context/index.ts'
export type {
  ContextSection, ContextSectionResolveInput, ContextSectionScope, ContextSectionState,
  ContextToolTouch,
} from './agent/context/index.ts'
