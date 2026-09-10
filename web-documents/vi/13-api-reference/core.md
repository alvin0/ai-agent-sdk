# `@alvin0/ai-agent-sdk-core`

Runtime: **Universal**. Mã đã phát hành dùng ECMAScript, kiểu tương thích Fetch,
Web Streams, `AbortController`, đo thời gian hiệu năng, và Web Crypto. Nó không
dùng builtin của Node, `process`, `Buffer`, đường dẫn cục bộ, truy cập hệ tệp,
tiến trình con, hay stdio.

```bash
pnpm add @alvin0/ai-agent-sdk-core
```

## Các điểm vào

| Định danh | Đối tượng dùng |
| --- | --- |
| `@alvin0/ai-agent-sdk-core` | Ứng dụng — facade root đã biên soạn. |
| `@alvin0/ai-agent-sdk-core/agent` | Viết agent và vòng lặp tầng thấp. |
| `@alvin0/ai-agent-sdk-core/provider` | Tác giả provider và thông tin xác thực. |
| `@alvin0/ai-agent-sdk-core/tools` | Tác giả tool source. |
| `@alvin0/ai-agent-sdk-core/skills` | Tác giả skill provider. |
| `@alvin0/ai-agent-sdk-core/memory` | Tác giả memory store. |
| `@alvin0/ai-agent-sdk-core/observability` | Bus quan sát và tác giả exporter. |

Root là một facade **chỉ re-export** đã biên soạn. Các subpath tập trung và root
đều là khung nhìn lên cùng một chủ sở hữu hiện thực chuẩn nội bộ — chúng không
bao giờ sở hữu bản sao của lớp, interface, registry, bus, hay trạng thái
singleton.

---

## Root — ghép nối

```ts
createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
```

| Tuỳ chọn | Kiểu | Ghi chú |
| --- | --- | --- |
| `providers` | `readonly ComposableModelProviderPlugin[]` | Bắt buộc. |
| `defaultProvider` | `string` | Tuyến dùng khi agent bỏ trống `model.provider`. |
| `signal` | `AbortSignal` | Huỷ quá trình khởi động. |
| `resource` | `RuntimeObservationResourceInput` | `serviceName`, `serviceVersion`, `environment`, `attributes`. Nhãn runtime (`node`/`edge`/`browser`) do SDK **tự phát hiện**, không truyền vào. |
| `observability` | `RuntimeOwnerObservabilityOptions` | Xem bên dưới. |
| `closeTimeoutMs` | `number` | Deadline làm lắng cho `close()`. |
| `startupTimeoutMs` | `number` | Deadline cho ranh giới `ready()` của provider. |
| `diagnosticMaxEvents` / `diagnosticMaxBytes` | `number` | Chặn trên vòng đệm chẩn đoán. |

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

## Root — agent

```ts
defineAgent(input: AgentDefinitionInput): DefinedAgent
cloneAgent(agent: DefinedAgent, overrides: CloneAgentOverrides): DefinedAgent
```

`DefinedAgent` còn phơi ra `.with(overrides)` để tạo biến thể cục bộ giữ nguyên
danh tính, cùng `createSession()` và `resumeSession()`.

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

## Root — tool và broker

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

Kiểu: `ToolDefinition`, `ToolRunContext`, `RuntimeSchema`, `ApprovalBroker`,
`ApprovalDecision`, `ApprovalRequest`, `ApprovalStateStore`,
`ToolExecutionBackend`, `ToolExecutionCapabilities`, `ToolExecutionRequest`,
`ToolExecutionStore`, `ToolOperation`, `ToolOperationClaim`, `UserInputAnswer`,
`UserInputBroker`, `UserInputDecision`, `UserInputOption`, `UserInputQuestion`,
`UserInputRequest`, `UserInputResponse`.

Xem [`Tool`](/vi/13-api-reference/tool) và
[Durable Execution](/vi/03-tools/durable-execution).

## Root — context section

```ts
defineContextSection(input: ContextSection): ContextSection

CONTEXT_SECTION_ID_PATTERN      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
CONTEXT_SECTION_INVALID         // mã AgentSdkError
MAX_CONTEXT_SECTION_TEXT_BYTES  // 262_144
```

Kiểu: `ContextSection`, `ContextSectionResolveInput`, `ContextSectionScope`,
`ContextSectionState`, `ContextToolTouch`, `AgentInput`.

Section là một callback tính lại thuần khiết: core SDK không bao giờ chạm hệ tệp,
đồng hồ hay mạng thay cho nó. `@alvin0/ai-agent-sdk-instructions-node` là bản hiện thực
Node cho các tệp kiểu `AGENTS.md`. Xem
[Context Sections](/vi/02-agents/context-sections).

---

## Root — message, stream, registry, lỗi

Root re-export toàn bộ từ vựng trung lập:

| Nhóm | Export đáng chú ý |
| --- | --- |
| Message | `createTextMessage`, `createUserMessage`, `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `ContentBlock`, `TextBlock`, `ImageBlock`, `ReasoningBlock`, `ToolCallBlock`, `ToolResultBlock`, `NativeToolCallBlock`, `MessageSource` |
| Stream | `BlockAssembler`, `StreamChunk`, `FinishReason`, `FinishReasonMap`, `TokenUsage`, `ReplayEnvelope` |
| Registry | `ModelRegistry`, `ModelAdapter`, `withRetry`, `RetryPolicyConfig`, `ResolvedRetryPolicy`, `ModelInfo`, `ResolvedModelInfo`, `GenerateOptions`, `ToolChoice`, `NativeToolSchema` |
| Lỗi | `AgentSdkError`, `MODEL_ERROR_CODES`, `REGISTRY_ERROR_CODES`, `ModelFailure`, `SupportSafeError`, `CapabilityIdentityConflict` |
| Nguyên thuỷ | `ToolCallId`, `ReasoningEffortId`, `JsonObject`, `JsonValue` |
| Log | `SdkLogger`, `LogLevel` |

> Phần lắp ráp registry/plugin tầng thấp vẫn với tới được ở root theo sổ cái API
> đã đóng băng. Ứng dụng thông thường nên dùng `AgentRuntime` thay thế.

---

## `/agent`

Tuyến để viết agent, cộng với vòng lặp tầng thấp:

```ts
import {
  History, ToolRegistry, AgentTeam,
  runAgent, runTurn, defineAgent, defineSkill, defineSkillProvider,
  buildTraceTree,
  createManagedAgentTeam, createDefinedAgentTeam,
} from '@alvin0/ai-agent-sdk-core/agent'
```

Nó re-export cùng các kiểu runtime như root — `AgentRuntime`, `RuntimeAgent`,
`RuntimeAgentSession`, `RunReport`, `RunTerminalRecord`, `SupportSafeError` —
nên một module tập trung vào agent chỉ cần định danh này.

---

## `/provider`

Dành cho tác giả provider và thông tin xác thực.

```ts
export { AgentSdkError, ModelAdapter, ModelRegistry }
export { defineModelProviderPlugin, PROVIDER_PLUGIN_API_VERSION }
export { defineCredentialSource, defineCredentialStore, CREDENTIAL_CAPABILITY_API_VERSION }
```

Các kiểu gồm `ComposableModelProviderPlugin`, `ComposableModelProviderRegistrar`,
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

Phạm vi bộ nhớ là tường minh — theo hội thoại hoặc cố định — kèm ghi đè theo từng
session, quyền sở hữu kiểu mượn, và danh tính gắn kết snapshot để cô lập giữa các
tenant.

---

## `/observability`

```ts
export { createObservability }
export { MemoryObservationExporter, TestObservationExporter }
export { projectLog, projectMetrics, projectTrace }
export { defineObservationExporter, OBSERVATION_EXPORTER_API_VERSION }
```

Các kiểu gồm `ObservationBoundary`, `ObservationDeliveryAck`,
`ObservationDeliveryBatch`, `ObservationEvent`, `ObservationExportItem`,
`ObservationPort`, `ObservationResource`, `RunReport`, `RunTerminalRecord`,
`SafeErrorRecord`, `UsageCounters`, `UsageCoverage`, `AttemptUsageReport`,
`ModelCallReport`, `DiagnosticSnapshot`, `RuntimeObservationHealthSnapshot`.

`MemoryObservationExporter` **chỉ dành cho test và kiểm tra cục bộ** — nó không
bao giờ tuyên bố tính bền vững.

## Đọc tiếp

- [Runtime, agent, session](/vi/02-agents/creating-an-agent)
- [Provider](/vi/09-providers/)
