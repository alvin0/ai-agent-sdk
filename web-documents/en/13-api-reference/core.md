# `@alvin0/ai-agent-sdk-core`

Runtime: **Universal**. Published code uses ECMAScript, Fetch-compatible types,
Web Streams, `AbortController`, performance timing, and Web Crypto. It does not
use Node built-ins, `process`, `Buffer`, local paths, filesystem access, child
processes, or stdio.

```bash
pnpm add @alvin0/ai-agent-sdk-core
```

## Entrypoints

| Specifier | Audience |
| --- | --- |
| `@alvin0/ai-agent-sdk-core` | Applications — the curated root facade. |
| `@alvin0/ai-agent-sdk-core/agent` | Agent authoring and the low-level loop. |
| `@alvin0/ai-agent-sdk-core/provider` | Provider and credential authors. |
| `@alvin0/ai-agent-sdk-core/tools` | Tool-source authors. |
| `@alvin0/ai-agent-sdk-core/skills` | Skill-provider authors. |
| `@alvin0/ai-agent-sdk-core/memory` | Memory-store authors. |
| `@alvin0/ai-agent-sdk-core/observability` | Observation bus and exporter authors. |

The root is a curated **re-export-only** facade. Focused subpaths and the root
are views over one internal canonical implementation owner — they never own
copied classes, interfaces, registries, buses, or singleton state.

---

## Root — composition

```ts
createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
```

| Option | Type | Notes |
| --- | --- | --- |
| `providers` | `readonly ComposableModelProviderPlugin[]` | Required. |
| `defaultProvider` | `string` | Route used when an agent omits `model.provider`. |
| `signal` | `AbortSignal` | Aborts startup. |
| `resource` | `RuntimeObservationResourceInput` | `serviceName`, `serviceVersion`, `environment`, `attributes`. The runtime label (`node`/`edge`/`browser`) is **detected**, not passed. |
| `observability` | `RuntimeOwnerObservabilityOptions` | See below. |
| `closeTimeoutMs` | `number` | Quiescence deadline for `close()`. |
| `startupTimeoutMs` | `number` | Deadline for provider `ready()` boundaries. |
| `diagnosticMaxEvents` / `diagnosticMaxBytes` | `number` | Bound the diagnostic ring. |

```ts
interface AgentRuntime {
  providers(): readonly RuntimeProviderInfo[]
  modelCatalog(route: string, options?: ModelCatalogOptions): Promise<RuntimeModelCatalogSnapshot>
  agent(definition: RuntimeAgentBindingInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  logger(context?: { scope?: string; fields?: Readonly<JsonObject> }): SdkLogger
  diagnostics(): RuntimeDiagnosticSnapshot
  close(options?: { signal?: AbortSignal }): Promise<RuntimeCloseReport>
}
```

### `RuntimeOwnerObservabilityOptions`

```ts
{
  mode?: DeliveryMode                     // 'operational' | 'reliable' | 'audit'
  content?: 'none' | 'metadata'
  minimumLogLevel?: LogLevel
  exporters?: readonly RuntimeObservationExporterRegistration[]
  processors?: readonly ObservationProcessor[]
  redactors?: readonly ContentRedactor[]
  includeErrorStacks?: boolean
  openSpan?: (input: OpenObservationSpanInput) => ObservationSpan
  maxQueueEvents?: number
  maxQueueBytes?: number
  maxBatchEvents?: number
  maxBatchBytes?: number
  flushTimeoutMs?: number
  shutdownTimeoutMs?: number
}
```

### `RuntimeCloseReport`

```ts
{
  state: 'closed'
  quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  deadlineReached: boolean
  activeRunsAtClose: number
  abortedRuns: number
  unsettledRuns: number
  operations: readonly RuntimeOperationCloseSummary[]
  components: readonly RuntimeComponentCloseReport[]
  observationHealth: RuntimeObservationHealthSnapshot
}
```

---

## Root — agents

```ts
defineAgent(input: AgentDefinitionInput): DefinedAgent
cloneAgent(agent: DefinedAgent, overrides: CloneAgentOverrides): DefinedAgent
```

`DefinedAgent` also exposes `.with(overrides)` for a local variant that keeps the
same identity, `createSession()`, and `resumeSession()`.

### `RuntimeAgent`

```ts
interface RuntimeAgent {
  readonly model: ModelTarget
  generate(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  createSession(options?: RuntimeAgentSessionOptions): RuntimeAgentSession
  resumeSession(snapshot: RuntimeAgentSessionSnapshot, options?: RuntimeAgentSessionOptions): RuntimeAgentSession
}
```

### `RuntimeAgentSession`

```ts
interface RuntimeAgentSession {
  readonly conversationId: string
  readonly isRunning: boolean
  run(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  inject(input: string): number
  snapshot(): RuntimeAgentSessionSnapshot
  compact(options?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null>
  reset(): void
  whenIdle(signal?: AbortSignal): Promise<void>
}
```

### `RuntimeAgentRunHandle`

```ts
interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}
```

---

## Root — tools and brokers

```ts
defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args>
defineToolFromSchema<T>(schema: RuntimeSchema<T>, definition): ToolDefinition<T>

createApprovalBroker(options?: InteractiveApprovalBrokerOptions): InteractiveApprovalBroker
fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
createApprovalRequest(input): ApprovalRequest
withApprovalPersistence(broker: ApprovalBroker, store: ApprovalStateStore): ApprovalBroker

createToolExecutionInterceptor(options): ToolInterceptor
localToolExecutionBackend: ToolExecutionBackend

createUserInputBroker(options?: InteractiveUserInputBrokerOptions): InteractiveUserInputBroker
fixedUserInputBroker(decision: UserInputDecision): UserInputBroker
```

Types: `ToolDefinition`, `ToolRunContext`, `RuntimeSchema`, `ApprovalBroker`,
`ApprovalDecision`, `ApprovalRequest`, `ApprovalStateStore`,
`ToolExecutionBackend`, `ToolExecutionCapabilities`, `ToolExecutionRequest`,
`ToolExecutionStore`, `ToolOperation`, `ToolOperationClaim`, `UserInputAnswer`,
`UserInputBroker`, `UserInputDecision`, `UserInputOption`, `UserInputQuestion`,
`UserInputRequest`, `UserInputResponse`.

See [`Tool`](/en/13-api-reference/tool) and
[Durable Execution](/en/03-tools/durable-execution).

## Root — context sections

```ts
defineContextSection(input: ContextSection): ContextSection

CONTEXT_SECTION_ID_PATTERN      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
CONTEXT_SECTION_INVALID         // AgentSdkError code
MAX_CONTEXT_SECTION_TEXT_BYTES  // 262_144
```

Types: `ContextSection`, `ContextSectionResolveInput`, `ContextSectionScope`,
`ContextSectionState`, `ContextToolTouch`, `AgentInput`.

A section is a pure recompute callback: the core SDK never touches a filesystem,
a clock, or a network on its behalf. `@alvin0/ai-agent-sdk-instructions-node` is the
Node implementation for `AGENTS.md`-style files. See
[Context Sections](/en/02-agents/context-sections).

---

## Root — messages, streams, registry, errors

The root re-exports the whole neutral vocabulary:

| Group | Notable exports |
| --- | --- |
| Messages | `createTextMessage`, `createUserMessage`, `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `ContentBlock`, `TextBlock`, `ImageBlock`, `DocumentBlock`, `ReasoningBlock`, `ToolCallBlock`, `ToolResultBlock`, `NativeToolCallBlock`, `MessageSource` |
| Content projection | `contentHasImage`, `contentHasDocument`, `projectImagesForTextModel`, `projectDocumentsForTextModel`, `textOnlyImageText`, `textOnlyDocumentText` |
| Streams | `BlockAssembler`, `StreamChunk`, `FinishReason`, `FinishReasonMap`, `TokenUsage`, `ReplayEnvelope` |
| Registry | `ModelRegistry`, `ModelAdapter`, `withRetry`, `RetryPolicyConfig`, `ResolvedRetryPolicy`, `ModelInfo`, `ResolvedModelInfo`, `GenerateOptions`, `ToolChoice`, `NativeToolSchema` |
| Errors | `AgentSdkError`, `MODEL_ERROR_CODES`, `REGISTRY_ERROR_CODES`, `ModelFailure`, `SupportSafeError`, `CapabilityIdentityConflict` |
| Primitives | `ToolCallId`, `ReasoningEffortId`, `JsonObject`, `JsonValue` |
| Logging | `SdkLogger`, `LogLevel` |

> Low-level registry/plugin assembly remains reachable at the root under the
> frozen API ledger. Normal applications should use `AgentRuntime` instead.

---

## `/agent`

The agent authoring route plus the low-level loop:

```ts
import {
  History, ToolRegistry, AgentTeam,
  runAgent, runTurn, defineAgent, defineSkill, defineSkillProvider,
  buildTraceTree,
  createManagedAgentTeam, createDefinedAgentTeam,
} from '@alvin0/ai-agent-sdk-core/agent'
```

It re-exports the same runtime types as the root — `AgentRuntime`,
`RuntimeAgent`, `RuntimeAgentSession`, `RunReport`, `RunTerminalRecord`,
`SupportSafeError` — so an agent-focused module needs only this specifier.

---

## `/provider`

For provider and credential authors.

```ts
export { AgentSdkError, ModelAdapter, ModelRegistry }
export { defineModelProviderPlugin, PROVIDER_PLUGIN_API_VERSION }
export { defineCredentialSource, defineCredentialStore, CREDENTIAL_CAPABILITY_API_VERSION }
```

Types include `ComposableModelProviderPlugin`, `ComposableModelProviderRegistrar`,
`ModelProviderPluginDefinition`, `ModelTarget`, `CredentialSource`,
`CredentialStore`, `CredentialRecord`, `CredentialCommitInput`,
`CredentialCommitResult`, `AdapterRegistrationHandle`, `PreparedAdapterCall`,
`ProviderAttemptHandle`, `StreamMiddleware`, `ModelInvocationContext`,
`NativeToolSchemaMap`, `UsageCounters`.

---

## `/tools`

```ts
export { defineToolSource, TOOL_SOURCE_API_VERSION }
export type {
  ToolCatalogSnapshot, ToolSource, ToolSourceDefinition,
  ToolSourceRunReference, ToolSourceSnapshotOptions, ToolSchema,
}
```

---

## `/skills`

```ts
export { defineSkillProviderPlugin, SKILL_PROVIDER_API_VERSION, SKILL_ERROR_CODES }
export type {
  ActivatedSkillSnapshot, RuntimeSkillCandidate, RuntimeSkillLookupOptions,
  RuntimeSkillSource, SkillCatalogSnapshot, SkillProviderDefinition,
  SkillProviderPlugin, SkillReference,
}
```

---

## `/memory`

```ts
export { defineMemoryStore, MEMORY_STORE_API_VERSION, MEMORY_ERROR_CODES }
export type {
  MemoryBinding, MemoryCommitInput, MemoryCommitResult, MemoryLoadResult,
  MemoryScope, MemoryStore, MemoryStoreDefinition, MemoryStoreOptions,
}
```

Memory scopes are explicit — conversation or fixed — with per-session override,
borrowed ownership, and snapshot binding identity for cross-tenant isolation.

---

## `/observability`

```ts
export { createObservability }
export { MemoryObservationExporter, TestObservationExporter }
export { projectLog, projectMetrics, projectTrace }
export { defineObservationExporter, OBSERVATION_EXPORTER_API_VERSION }
```

Types include `ObservationBoundary`, `ObservationDeliveryAck`,
`ObservationDeliveryBatch`, `ObservationEvent`, `ObservationExportItem`,
`ObservationPort`, `ObservationResource`, `RunReport`, `RunTerminalRecord`,
`SafeErrorRecord`, `UsageCounters`, `UsageCoverage`, `AttemptUsageReport`,
`ModelCallReport`, `DiagnosticSnapshot`, `RuntimeObservationHealthSnapshot`.

`MemoryObservationExporter` is for **test and local inspection only** — it never
claims durability.

## Read next

- [Runtime, agents, sessions](/en/02-agents/creating-an-agent)
- [Providers](/en/09-providers/)
