/** Recommended v1 design surface. This file is compile-only and is not product code. */

export declare const PROVIDER_PLUGIN_API_VERSION: 1
export declare const SKILL_PROVIDER_API_VERSION: 1
export declare const MEMORY_STORE_API_VERSION: 1
export declare const CREDENTIAL_CAPABILITY_API_VERSION: 1
export declare const OBSERVATION_EXPORTER_API_VERSION: 1
export declare const TOOL_SOURCE_API_VERSION: 1
export declare const PLUGIN_ERROR_CODES: {
  readonly INSTALL_FAILED: 'PLUGIN_INSTALL_FAILED'
  readonly CLEANUP_FAILED: 'PLUGIN_CLEANUP_FAILED'
  readonly SETUP_ASYNC_UNSUPPORTED: 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
  readonly CLEANUP_ASYNC_UNSUPPORTED: 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'
}
export declare const RUNTIME_ERROR_CODES: {
  readonly CLOSING: 'RUNTIME_CLOSING'
  readonly CLOSED: 'RUNTIME_CLOSED'
  readonly OPERATION_TIMEOUT: 'RUNTIME_OPERATION_TIMEOUT'
}
export declare const MEMORY_ERROR_CODES: {
  readonly BINDING_REQUIRED: 'MEMORY_BINDING_REQUIRED'
  readonly BINDING_MISMATCH: 'MEMORY_BINDING_MISMATCH'
  readonly INVALID_SCOPE: 'MEMORY_INVALID_SCOPE'
}
export declare const SKILL_ERROR_CODES: {
  readonly CATALOG_INVALID: 'SKILL_CATALOG_INVALID'
  readonly REFERENCE_INVALID: 'SKILL_REFERENCE_INVALID'
  readonly REFERENCE_UNAVAILABLE: 'SKILL_REFERENCE_UNAVAILABLE'
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject { readonly [key: string]: JsonValue }
export declare function isJsonValue(value: unknown): value is JsonValue
export declare function assertNever(value: never, context?: string): never
export declare function deepFreeze<T>(value: T): T
export declare function detachedFrozen<T>(value: T): T
export declare const SDK_VERSION: '0.1.0'
export declare function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean>

declare const BRAND: unique symbol
export type Branded<B extends string> = string & { readonly [BRAND]: B }
export type MessageId = Branded<'MessageId'>
export declare function MessageId(id: string): MessageId
export type ToolCallId = Branded<'ToolCallId'>
export declare function ToolCallId(id: string): ToolCallId
export type ProviderRequestId = Branded<'ProviderRequestId'>
export declare function ProviderRequestId(id: string): ProviderRequestId
export type ReasoningEffortId = Branded<'ReasoningEffortId'>
export declare function ReasoningEffortId(id: string): ReasoningEffortId

export interface ModelFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: ProviderRequestId
}

export declare function normalizeModelFailure(value: unknown): ModelFailure

export declare class AgentSdkError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions)
}

export declare const CONTEXT_WINDOW_EXCEEDED_CODE: 'CONTEXT_WINDOW_EXCEEDED'
export declare const QUOTA_EXCEEDED_CODE: 'QUOTA'
export declare const EMPTY_RESPONSE_CODE: 'EMPTY_RESPONSE'
export declare const MISSING_CREDENTIAL_CODE: 'MISSING_CREDENTIAL'
export declare const INVALID_CREDENTIAL_CODE: 'INVALID_CREDENTIAL'
export declare function isContextWindowExceededError(detail: string): boolean
export declare function isQuotaExceededError(detail: string): boolean
export declare function errorChain(value: unknown): string
export declare function isAgentSdkError(value: unknown): value is AgentSdkError

export interface ModelErrorOptions extends ErrorOptions {
  status?: number
  providerRetryAfterMs?: number
  requestId?: ProviderRequestId
}

export declare class ModelError extends AgentSdkError {
  readonly failure: ModelFailure
  constructor(message: string, code: string, options?: ModelErrorOptions)
}

export declare const MODEL_ERROR_CODES: Readonly<{
  readonly AUTH: 'AUTH'
  readonly RATE_LIMIT: 'RATE_LIMIT'
  readonly SERVER: 'SERVER'
  readonly TIMEOUT: 'TIMEOUT'
  readonly TRANSPORT: 'TRANSPORT'
  readonly ABORTED: 'ABORTED'
  readonly TEARDOWN_TIMEOUT: 'MODEL_TEARDOWN_TIMEOUT'
  readonly INVALID_REQUEST: 'INVALID_REQUEST'
  readonly MALFORMED_RESPONSE: 'MALFORMED_RESPONSE'
  readonly STREAM_CLOSED: 'STREAM_CLOSED'
  readonly UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT'
  readonly UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION'
  readonly UNKNOWN: 'UNKNOWN'
}>

export declare const REGISTRY_ERROR_CODES: Readonly<{
  readonly NO_ADAPTER: 'NO_ADAPTER'
  readonly DUPLICATE_ADAPTER: 'DUPLICATE_ADAPTER'
  readonly INVALID_ADAPTER: 'INVALID_ADAPTER'
  readonly INVALID_CATALOG: 'INVALID_CATALOG'
  readonly INVALID_MODEL_INFO: 'INVALID_MODEL_INFO'
  readonly UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT'
  readonly UNSUPPORTED_NATIVE_TOOL: 'UNSUPPORTED_NATIVE_TOOL'
  readonly OUTPUT_TOKEN_LIMIT_EXCEEDED: 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
  readonly INVALID_PREPARED_CALL: 'INVALID_PREPARED_CALL'
  readonly REGISTRATION_DISPOSED: 'REGISTRATION_DISPOSED'
}>

export type AssistantTextPhase = 'commentary' | 'final-answer'

export interface TextBlock {
  type: 'text'
  text: string
  phase?: AssistantTextPhase
  annotations?: readonly TextAnnotation[]
}

export interface UrlCitationAnnotation {
  type: 'url-citation'
  url: string
  title?: string
  startIndex?: number
  endIndex?: number
  providerState?: unknown
}

export interface TextAnnotationMap {
  'url-citation': UrlCitationAnnotation
}

export type TextAnnotation = TextAnnotationMap[keyof TextAnnotationMap]

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  providerState?: unknown
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export type ImageSource =
  | { kind: 'base64'; mediaType: ImageMediaType; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string }
export type ImageDetail = 'auto' | 'low' | 'high' | 'original'

export interface ImageBlock {
  type: 'image'
  source: ImageSource
  detail?: ImageDetail
}

export interface NativeToolCallBlock {
  type: 'native-tool-call'
  id: string
  name: string
  status?: string
  arguments?: JsonValue
  content: ContentBlock[]
  providerState?: unknown
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: ToolCallId
  name: string
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolCallId
  content: ContentBlock[]
  isError?: boolean
}

export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'native-tool-call': NativeToolCallBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

export type ContentBlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[ContentBlockType]

export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: ModelFailure }
  'error': { kind: 'error'; failure: ModelFailure }
}

export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface ReplayEnvelope {
  response: unknown
  blocks?: readonly unknown[]
}

export interface AssistantProvenance {
  provider: string
  model: string
  replayState?: unknown
}

export interface ModelMessageSource extends AssistantProvenance { kind: 'model' }
export interface ToolMessageSource { kind: 'tool'; callId: ToolCallId }
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly teamId: string
  readonly messageId: string
  readonly sender: string
  readonly senderAgentId: string
}
export interface A2AMessageSource {
  readonly kind: 'a2a-message'
  readonly contextId: string
  readonly messageId: string
  readonly taskId?: string
}

export interface MessageSourceMap {
  user: { kind: 'user' }
  app: { kind: 'app'; producer: string }
  model: ModelMessageSource
  tool: ToolMessageSource
  'agent-message': AgentMessageSource
  'a2a-message': A2AMessageSource
}

export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

export interface UserMessage extends Message { readonly role: 'user' }
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: readonly [ToolResultBlock]
  readonly source: ToolMessageSource
}

type NewMessage = Omit<Message, 'id'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

export declare function freezeMessage<T extends Message>(message: T): T
export declare function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'>
export declare function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'>
export declare function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage
export declare function createTextMessage(text: string): UserMessage

export interface ToolResultMessageInput {
  readonly callId: ToolCallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

export declare function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage

export declare function contentHasImage(content: readonly ContentBlock[]): boolean
export declare function textOnlyImageText(block: ImageBlock): string
export declare function projectImagesForTextModel(
  messages: readonly Message[],
): readonly Message[]

export type ApiKeyRejection = 'empty' | 'illegalCharacters'
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }
export declare function normalizeApiKey(raw: string): ApiKeyCheck
export declare function assertUsableApiKey(
  raw: string,
  provider: string,
  ref: string,
): string

export interface AppIdentity {
  product: string
  version: string
  url: string
}

export declare const APP_IDENTITY: AppIdentity
export declare function userAgent(identity?: AppIdentity): string
export declare function attributionHeaders(identity?: AppIdentity): Record<string, string>

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface SdkLogger {
  child(fields: Readonly<JsonObject>): SdkLogger
  trace(message: string, fields?: Readonly<JsonObject>): void
  debug(message: string, fields?: Readonly<JsonObject>): void
  info(message: string, fields?: Readonly<JsonObject>): void
  warn(message: string, fields?: Readonly<JsonObject>): void
  error(message: string, fields?: Readonly<JsonObject>): void
  fatal(message: string, fields?: Readonly<JsonObject>): void
}

/** Metadata-only field grammar shared by first-party integration packages. */
export type IntegrationOperationEvidenceFields =
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'logical-start'
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'attempt-start'
      readonly attemptId: string
      readonly attemptNumber: number
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'attempt-terminal'
      readonly attemptId: string
      readonly attemptNumber: number
      readonly status: OperationStatus
      readonly durationMs: number
      readonly errorCode?: string
    })
  | (JsonObject & {
      readonly integrationSchemaVersion: 1
      readonly integrationFamily: string
      readonly integrationOperation: string
      readonly operationId: string
      readonly kind: 'logical-terminal'
      readonly status: OperationStatus
      readonly durationMs: number
      readonly errorCode?: string
    })

/** Runtime-bound context; resource and correlation IDs cannot be overridden. */
export interface RuntimeLoggerContext {
  readonly scope?: string
  readonly fields?: Readonly<JsonObject>
}

export interface ModelTarget {
  readonly provider: string
  readonly id: string
}

export interface ProviderInfo {
  readonly id: string
  readonly name: string
}

/** Runtime topology row. `id` remains the compatibility alias of `route`. */
export interface RuntimeProviderInfo extends ProviderInfo {
  readonly route: string
  readonly pluginId: string
  readonly family: string
  /** Present only on the route owning the configured default. */
  readonly defaultModel?: ModelTarget
}

export interface ModelModalityMap {
  text: 'text'
  image: 'image'
}

export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

export interface ModelInfo extends ModelTarget {
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ModelModality[]
  readonly outputModalities?: readonly ModelModality[]
  readonly nativeTools?: readonly NativeToolName[]
}

export type ModelCatalogState =
  | 'static'
  | 'fresh'
  | 'empty'
  | 'stale'
  | 'unavailable'

export interface ModelCatalogOptions {
  readonly signal?: AbortSignal
  readonly refresh?: 'if-stale' | 'force'
}

export interface ModelCatalogSnapshot {
  readonly provider: ProviderInfo
  readonly state: ModelCatalogState
  readonly revision: string
  readonly models: readonly ModelInfo[]
  readonly observedAt: string
  readonly expiresAt?: string
  readonly retryAt?: string
  readonly error?: SupportSafeError
}

export interface RuntimeModelCatalogSnapshot extends Omit<ModelCatalogSnapshot, 'provider'> {
  readonly provider: RuntimeProviderInfo
}

export interface ModelContext {
  contextWindow: number
}

export interface ReasoningEffortInfo {
  id: ReasoningEffortId
  name: string
  description?: string
}

export interface ModelReasoningInfo {
  efforts: readonly ReasoningEffortInfo[]
  defaultEffort?: ReasoningEffortId
}

export interface ResolvedModelInfo extends ModelInfo {
  readonly context?: ModelContext
  readonly defaultMaxTokens?: number
  readonly maxOutputTokens?: number
  readonly reasoning?: ModelReasoningInfo
}

export interface WebSearchLocation {
  readonly city?: string
  readonly region?: string
  readonly country?: string
  readonly timezone?: string
}

export interface NativeWebSearchTool {
  readonly type: 'native'
  readonly name: 'web-search'
  readonly searchContextSize?: 'low' | 'medium' | 'high'
  readonly allowedDomains?: readonly string[]
  readonly blockedDomains?: readonly string[]
  readonly userLocation?: WebSearchLocation
  readonly maxUses?: number
}

export interface NativeImageGenerationTool {
  readonly type: 'native'
  readonly name: 'image-generation'
  readonly size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  readonly quality?: 'auto' | 'low' | 'medium' | 'high'
  readonly format?: 'png' | 'jpeg' | 'webp'
  readonly background?: 'auto' | 'transparent' | 'opaque'
  readonly partialImages?: number
}

/** Merge-extensible semantic vocabulary for provider-executed tools. */
export interface NativeToolSchemaMap {
  readonly 'web-search': NativeWebSearchTool
  readonly 'image-generation': NativeImageGenerationTool
}

export type NativeToolName = keyof NativeToolSchemaMap
export type NativeToolSchema = NativeToolSchemaMap[NativeToolName]
export type ModelToolSchema = ToolSchema | NativeToolSchema

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'native'; readonly name: NativeToolName }

export declare function isNativeToolSchema(
  tool: ModelToolSchema,
): tool is NativeToolSchema

export interface BackoffConfig {
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly jitterRatio?: number
}

export interface NormalRetryPolicyConfig {
  readonly mode: 'normal'
  readonly maxRetries?: number
  readonly retryableCodes?: readonly string[]
  readonly backoff?: BackoffConfig
}

export interface AlwaysRetryPolicyConfig {
  readonly mode: 'always'
  readonly backoff?: BackoffConfig
}

export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

export declare const MAX_TIMER_DELAY_MS: 2147483647

export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always'
}

export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

export declare function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path: string,
): ResolvedRetryPolicy
export declare function backoffDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  random?: () => number,
): number
export declare function isRetryable(
  policy: ResolvedRetryPolicy,
  code: string,
  attemptsSoFar: number,
): boolean

export interface GenerateOptions {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
  readonly messages: readonly Message[]
  readonly system?: string
  readonly tools?: readonly ModelToolSchema[]
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
  readonly temperature?: number
  readonly topP?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly signal?: AbortSignal
}

export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: ContentBlockType }
  | {
    readonly type: 'text-delta'
    readonly index: number
    readonly text: string
    readonly phase?: AssistantTextPhase
  }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'image-delta'
    readonly index: number
    readonly itemId: string
    readonly data: string
    readonly mediaType: string
    readonly partialIndex?: number
  }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: ToolCallId
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | {
    readonly type: 'finish'
    readonly reason: FinishReason
    readonly replayState?: ReplayEnvelope
  }

export interface StartProviderAttemptInput {
  readonly provider: string
  readonly model: string
  readonly method: string
  readonly origin: string
}

export interface EndProviderAttemptInput {
  readonly status: OperationStatus
  readonly dispatchState: DispatchState
  readonly reported?: UsageCounters
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly error?: SafeErrorRecord
}

export interface ProviderRetryScheduledInput {
  readonly nextAttemptNumber: number
  readonly delayMs: number
  readonly failureCode: string
}

export interface ProviderAttemptHandle {
  readonly attemptId: string
  readonly attemptNumber: number
  readonly traceparent: string
  end(input: EndProviderAttemptInput): AttemptUsageReport
}

declare const OBSERVATION_ID_BRAND: unique symbol
export type TraceId = string & { readonly [OBSERVATION_ID_BRAND]: 'TraceId' }
export type SpanId = string & { readonly [OBSERVATION_ID_BRAND]: 'SpanId' }
export interface CorrelationContext {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly runId: string
  readonly conversationId?: string
  readonly turnId?: string
  readonly modelCallId?: string
  readonly attemptId?: string
  readonly toolCallId?: string
  readonly providerRequestId?: string
  readonly sessionId?: string
}

/** One synchronous sequence and monotonic clock shared by every event in a run. */
export interface ObservationRunScope {
  nextSequence(): number
  monotonicMs(): number
}

export declare function createObservationRunScope(): ObservationRunScope
export declare function createTraceId(): TraceId
export declare function createSpanId(): SpanId
export declare function createOperationId(): string
export declare function isTraceId(value: unknown): value is TraceId
export declare function isSpanId(value: unknown): value is SpanId
export declare function traceparent(
  context: Pick<CorrelationContext, 'traceId' | 'spanId'>,
): string
export declare function freezeCorrelation(context: CorrelationContext): CorrelationContext

export type ObservationSpanName =
  | 'sdk.agent.run'
  | 'sdk.agent.turn'
  | 'sdk.model.call'
  | 'sdk.provider.attempt'
  | 'sdk.tool.call'
  | 'sdk.compaction'
  | 'sdk.hook.call'
  | 'sdk.user.input.wait'
  | 'sdk.skill.operation'
  | 'sdk.memory.operation'
  | 'sdk.credential.operation'
  | 'sdk.integration.request'

export interface OpenObservationSpanInput {
  readonly name: ObservationSpanName
  readonly runId: string
  readonly parent?: CorrelationContext
  readonly correlation?: Omit<Partial<CorrelationContext>, 'traceId' | 'spanId' | 'parentSpanId' | 'runId'>
  readonly startedAt: string
  readonly monotonicMs: number
}

export interface ObservationSpan {
  readonly correlation: CorrelationContext
  readonly traceparent: string
  end(status: OperationStatus, endedAt: string, monotonicMs: number): void
}

export interface ObservationSpanSnapshot extends ObservationSpan {
  readonly end: ObservationSpan['end']
}

export declare function createCoreSpan(input: OpenObservationSpanInput): ObservationSpan
export declare function snapshotObservationSpan(value: unknown): ObservationSpanSnapshot | undefined
export declare function validObservationSpan(value: unknown): value is ObservationSpan

export interface ObservationProcessor {
  readonly id: string
  readonly transform: (event: ObservationEvent) => ObservationEvent | undefined
}

export interface ContentRedactor {
  readonly id: string
  readonly redact: (value: string, path: readonly string[]) => string
}

export interface ModelInvocationContext {
  readonly observation?: ObservationPort
  readonly resource?: ObservationResource
  readonly correlation?: Partial<CorrelationContext>
  readonly terminalCheckpointOwner?: 'model-call' | 'agent-run'
  readonly scope?: ObservationRunScope
  readonly logger?: SdkLogger
  readonly declareProviderAttemptAccounting?: () => void
  readonly startProviderAttempt?: (
    input: StartProviderAttemptInput,
    signal?: AbortSignal,
  ) => Promise<ProviderAttemptHandle>
  readonly recordProviderRetry?: (input: ProviderRetryScheduledInput) => void
}

export interface PreparedAdapterCall {
  readonly model: ResolvedModelInfo
  stream(
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk>
}

export declare abstract class ModelAdapter {
  providerInfo(provider: string): ProviderInfo
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined
  listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]>
  modelCatalog(
    provider: string,
    options?: ModelCatalogOptions,
  ): Promise<ModelCatalogSnapshot>
  resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo>
  prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall>
  abstract stream(
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk>
}

export interface AdapterRegistrationHandle {
  (): void
  replace(routes: readonly string[]): void
}

export type StreamMiddleware = (
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  context: ModelInvocationContext,
) => AsyncIterable<StreamChunk>

export interface ModelProviderRegistrar {
  registerAdapter(
    routes: readonly string[],
    adapter: ModelAdapter,
  ): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}

export interface ModelProviderPlugin {
  readonly id: string
  readonly displayName: string
  readonly family?: string
  setup(registrar: ModelProviderRegistrar): void | (() => void)
}

/** Normal composition plugin with inert route claims available before setup. */
export interface ComposableModelProviderPlugin extends ModelProviderPlugin {
  readonly kind: 'model-provider-plugin'
  readonly apiVersion: typeof PROVIDER_PLUGIN_API_VERSION
  readonly family?: string
  readonly routes: readonly string[]
  /** Explicit configured default, captured before setup; its route must be claimed. */
  readonly defaultModel?: ModelTarget
  readonly setup: (registrar: ModelProviderRegistrar) => void | (() => void)
}

export interface PluginRegistrationHandle {
  (): void
  readonly pluginId: string
}

export declare class PluginError extends AgentSdkError {
  readonly pluginId: string
  constructor(
    message: string,
    code: string,
    pluginId: string,
    options?: ErrorOptions,
  )
}

/** Helper-only registrar scoped to the definition's preflighted route claims. */
export interface ComposableModelProviderRegistrar {
  readonly logger: SdkLogger
  registerAdapter(
    adapter: ModelAdapter,
    routes?: readonly string[],
  ): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
}

/** Strict helper grammar: unlike `void`, `undefined` rejects accidental async callbacks. */
export type ProviderPluginCleanupDefinition = () => undefined
export type ModelProviderPluginDefinition = Omit<
  ComposableModelProviderPlugin,
  'kind' | 'apiVersion' | 'setup'
> & {
  readonly setup: (
    registrar: ComposableModelProviderRegistrar,
  ) => undefined | ProviderPluginCleanupDefinition
}
export declare function defineModelProviderPlugin(
  definition: ModelProviderPluginDefinition,
): ComposableModelProviderPlugin

export interface CallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: readonly string[]
}

export interface CallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

export declare function callConfigEquals(a: CallConfig, b: CallConfig): boolean

export interface PreparedCall {
  readonly config: CallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: ModelContext
  readonly inputModalities?: readonly ModelModality[]
  readonly model: ResolvedModelInfo
  readonly adapterDefaults: CallConfigAdapterDefaults
  stream(options: GenerateOptions, context?: ModelInvocationContext): ModelCallHandle
}

export interface ModelRegistryOptions {
  readonly maxCatalogModels?: number
  readonly maxCatalogBytes?: number
  readonly observation?: ObservationPort
  readonly observationResource?: ObservationResource
}

export declare class ModelRegistry {
  constructor(options?: ModelRegistryOptions)
  install(plugin: ModelProviderPlugin): PluginRegistrationHandle
  registerAdapter(
    providers: readonly string[],
    adapter: ModelAdapter,
  ): AdapterRegistrationHandle
  use(middleware: StreamMiddleware): () => void
  onAdaptersUpdated(listener: () => void): () => void
  listProviders(): ProviderInfo[]
  listModels(provider: string): Promise<ModelInfo[]>
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo>
  retryPolicy(provider: string): ResolvedRetryPolicy
  prepareCall(
    config: CallConfig,
    signal?: AbortSignal,
    invocationContext?: ModelInvocationContext,
  ): Promise<PreparedCall>
  stream(options: GenerateOptions, context?: ModelInvocationContext): ModelCallHandle
}

export interface RetryAttempt {
  readonly provider: string
  readonly attempt: number
  readonly maxRetries: number | undefined
  readonly failure: ModelFailure
  readonly delayMs: number
}

export interface WithRetryOptions {
  policy?: RetryPolicyConfig
  random?: () => number
  onRetry?: (attempt: RetryAttempt) => void
  teardownTimeoutMs?: number
}

export declare function withRetry(
  adapter: ModelAdapter,
  options?: WithRetryOptions,
): ModelAdapter

export declare class BlockAssembler {
  push(chunk: StreamChunk): void
  blocks(): ContentBlock[]
  interruptedBlocks(): ContentBlock[]
  get usage(): TokenUsage | undefined
  get finish(): FinishReason
  get replayState(): ReplayEnvelope | undefined
  message(source: MessageSource): Message
}

export declare function withIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  teardownTimeoutMs?: number,
): AsyncGenerator<T>

export interface CredentialOperationOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface CredentialSource {
  readonly kind: 'credential-source'
  readonly apiVersion: typeof CREDENTIAL_CAPABILITY_API_VERSION
  readonly id: string
  readonly resolve: (options: CredentialOperationOptions) => string | Promise<string>
}

export type CredentialInput = string | CredentialSource

export interface CredentialRecord<Value> {
  readonly value: Value
  readonly revision: string
}

export interface CredentialCommitInput<Value> {
  readonly value: Value
  /** Null means create-only; a string means compare-and-swap replacement. */
  readonly expectedRevision: string | null
}

export interface CredentialCommitResult {
  readonly revision: string
}

export interface CredentialStore<Value> {
  readonly kind: 'credential-store'
  readonly apiVersion: typeof CREDENTIAL_CAPABILITY_API_VERSION
  readonly id: string
  readonly label: string
  readonly read: (options: CredentialOperationOptions) => Promise<CredentialRecord<Value> | undefined>
  readonly commit: (
    input: CredentialCommitInput<Value>,
    options: CredentialOperationOptions,
  ) => Promise<CredentialCommitResult>
}

export type CredentialStoreDefinition<Value> = Omit<
  CredentialStore<Value>,
  'kind' | 'apiVersion'
>

export declare function defineCredentialSource(input: {
  readonly id: string
  resolve(options: CredentialOperationOptions): string | Promise<string>
}): CredentialSource
export declare function defineCredentialStore<Value>(
  definition: CredentialStoreDefinition<Value>,
): CredentialStore<Value>

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export type ToolExecutionMode = 'parallel' | 'exclusive'

export interface ToolCallPosition {
  readonly turn: number
  readonly step: number
}

export interface ToolRunContext extends ToolCallPosition {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly signal: AbortSignal
  /** Always present on AgentRuntime execution paths; optional for legacy low-level callers. */
  readonly logger?: SdkLogger
  concludeTurn(): void
  addContext(content: string | readonly ContentBlock[]): void
}

export interface ToolDefinition<Args = unknown> extends ToolSchema {
  readonly parse?: (raw: unknown) => Args
  readonly execute: (
    input: Args,
    context: ToolRunContext,
  ) => Promise<JsonValue | void> | JsonValue | void
  readonly render?: (
    value: JsonValue | undefined,
    input: Args,
  ) => readonly ContentBlock[]
  readonly meta?: (value: JsonValue | undefined, input: Args) => JsonObject | undefined
  readonly timeoutMs?: number
  readonly isConcurrencySafe?: (input: Args) => boolean
}

export declare function defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args>
export declare function renderJsonValue(value: JsonValue | undefined): readonly ContentBlock[]
export declare function executionModeOf<Args>(
  tool: ToolDefinition<Args> | undefined,
  args: unknown,
): ToolExecutionMode

export interface ToolSuccess {
  readonly isError: false
  readonly value: JsonValue | undefined
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: true
}

export interface ToolFailure {
  readonly isError: true
  readonly error: { readonly message: string; readonly code: string }
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: never
}

export type ToolExecutionResult = ToolSuccess | ToolFailure

export type ApprovalDecision = 'allow' | 'deny' | 'abort'

export interface ApprovalRequest {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly args: unknown
  readonly reason?: string
  readonly turn: number
  readonly step: number
}

export interface ApprovalBroker {
  readonly request: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalDecision>
}

export interface InteractiveApprovalBroker extends ApprovalBroker {
  pending(): readonly ApprovalRequest[]
  onRequest(listener: (request: ApprovalRequest) => void): () => void
  resolve(callId: ToolCallId, decision: ApprovalDecision): boolean
  abortAll(): void
}

export interface InteractiveApprovalBrokerOptions { readonly maxPending?: number }

export declare function fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
export declare function createApprovalBroker(
  options?: InteractiveApprovalBrokerOptions,
): InteractiveApprovalBroker

export interface ToolCallContext extends ToolCallPosition {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly tool: ToolDefinition | undefined
  readonly rawArguments: string
  readonly args: unknown
  readonly signal: AbortSignal
  /** Always present on AgentRuntime execution paths; optional for legacy low-level callers. */
  readonly logger?: SdkLogger
}

export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string }

export type PostToolDecision =
  | { readonly kind: 'accept' }
  | {
    readonly kind: 'replace'
    readonly content: readonly ContentBlock[]
    readonly meta?: JsonObject
  }
  | {
    readonly kind: 'block'
    readonly feedback: readonly ContentBlock[]
    readonly code?: string
  }

export interface ToolInterceptor {
  readonly name: string
  readonly before?: (
    call: ToolCallContext,
    next: () => Promise<PreToolDecision>,
  ) => Promise<PreToolDecision>
  readonly around?: (
    call: ToolCallContext,
    next: () => Promise<ToolExecutionResult>,
  ) => Promise<ToolExecutionResult>
  readonly after?: (
    call: ToolCallContext,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>
}

export interface ToolCatalog {
  readonly get: (name: string) => ToolDefinition | undefined
  readonly has: (name: string) => boolean
  readonly names: () => readonly string[]
  readonly schemas: () => readonly ToolSchema[]
  readonly executionMode: (name: string, input: unknown) => ToolExecutionMode
}

export interface ToolFilter {
  allow?: readonly string[]
  deny?: readonly string[]
}

export declare const TOOL_REGISTRY_ERROR_CODES: Readonly<{
  readonly DUPLICATE_TOOL: 'DUPLICATE_TOOL'
  readonly INVALID_TOOL: 'INVALID_TOOL'
  readonly UNKNOWN_TOOL_FILTER: 'UNKNOWN_TOOL_FILTER'
}>

export declare class ToolRegistry implements ToolCatalog {
  register<Args>(definition: ToolDefinition<Args>): () => void
  registerAll(definitions: readonly ToolDefinition<never>[]): () => void
  get(name: string): ToolDefinition | undefined
  has(name: string): boolean
  names(): readonly string[]
  schemas(): readonly ToolSchema[]
  executionMode(name: string, args: unknown): ToolExecutionMode
  view(filter: ToolFilter): ToolCatalog
}

export interface ToolCallRequest {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly rawArguments: string
}

export interface DispatchToolCallOptions {
  readonly catalog: ToolCatalog
  readonly call: ToolCallRequest
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly teardownTimeoutMs?: number
  readonly defaultTimeoutMs?: number
  readonly onApprovalRequest?: (request: ApprovalRequest) => Promise<void> | void
  readonly onApprovalSettled?: (
    status: 'success' | 'error' | 'aborted',
    error?: unknown,
  ) => void
}

export interface PreparedToolCall {
  readonly options: DispatchToolCallOptions
  readonly context: ToolCallContext
  readonly argumentFailure?: ToolFailure
  readonly mode: ToolExecutionMode
}

export interface AuthorizedToolCall extends PreparedToolCall {
  readonly tool: ToolDefinition
}

export type AuthorizationOutcome =
  | { readonly kind: 'authorized'; readonly call: AuthorizedToolCall }
  | { readonly kind: 'final'; readonly result: ToolExecutionResult }

export declare function toolFailure(
  message: string,
  code: string,
  extra?: {
    meta?: JsonObject
    additionalContext?: readonly ContentBlock[]
  },
): ToolFailure
export declare function prepareToolCall(
  options: DispatchToolCallOptions,
): PreparedToolCall
export declare function authorizeToolCall(
  prepared: PreparedToolCall,
): Promise<AuthorizationOutcome>
export declare function dispatchAuthorizedToolCall(
  call: AuthorizedToolCall,
): Promise<ToolExecutionResult>
export declare function finalizeToolCall(
  call: AuthorizedToolCall,
  executed: ToolExecutionResult,
): Promise<ToolExecutionResult>
export declare function dispatchToolCall(
  options: DispatchToolCallOptions,
): Promise<ToolExecutionResult>

export type ToolErrorDisposition = 'respond-to-model' | 'fatal'

export declare const TOOL_ERROR_CODES: Readonly<{
  readonly UNKNOWN_TOOL: 'UNKNOWN_TOOL'
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS'
  readonly MALFORMED_ARGUMENTS: 'MALFORMED_ARGUMENTS'
  readonly TIMEOUT: 'TOOL_TIMEOUT'
  readonly ABORTED: 'TOOL_ABORTED'
  readonly ABORTED_BEFORE_DISPATCH: 'TOOL_ABORTED_BEFORE_DISPATCH'
  readonly DENIED: 'TOOL_DENIED'
  readonly INVALID_RESULT: 'INVALID_TOOL_RESULT'
  readonly FAILED: 'TOOL_FAILED'
  readonly BUDGET_EXHAUSTED: 'TOOL_BUDGET_EXHAUSTED'
  readonly CHECKPOINT_FAILED: 'CHECKPOINT_FAILED'
  readonly TEARDOWN_TIMEOUT: 'TOOL_TEARDOWN_TIMEOUT'
}>

export declare class ToolError extends AgentSdkError {
  readonly disposition: ToolErrorDisposition
  constructor(
    message: string,
    disposition: ToolErrorDisposition,
    code?: string,
    options?: ErrorOptions,
  )
  static respondToModel(
    message: string,
    code?: string,
    options?: ErrorOptions,
  ): ToolError
  static fatal(message: string, code?: string, options?: ErrorOptions): ToolError
}

export declare function toolErrorDisposition(value: unknown): ToolErrorDisposition

export interface ToolCatalogSnapshot {
  readonly revision: string
  readonly tools: readonly ToolDefinition[]
}

export interface ToolSourceSnapshotOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface ToolSource {
  readonly kind: 'tool-source'
  readonly apiVersion: typeof TOOL_SOURCE_API_VERSION
  readonly id: string
  /** Synchronous atomic snapshot; asynchronous refresh is source-owned and explicit. */
  readonly snapshot: (options: ToolSourceSnapshotOptions) => ToolCatalogSnapshot
}

export type ToolSourceDefinition = Omit<ToolSource, 'kind' | 'apiVersion'>
export declare function defineToolSource(definition: ToolSourceDefinition): ToolSource

export declare const SKILL_ID_PATTERN: RegExp
export declare const MAX_SKILL_INSTRUCTIONS_CHARS: 40000
export declare const MAX_SKILL_RESOURCE_CHARS: 40000
export declare const MAX_SKILL_ID_CHARS: 128
export declare const MAX_SKILL_NAME_CHARS: 256
export declare const MAX_SKILL_DESCRIPTION_CHARS: 2048
export declare const MAX_SKILL_RESOURCE_PATH_CHARS: 512

export interface SkillResourceBase {
  readonly kind: 'directory' | 'url' | 'opaque'
  readonly value: string
}

export interface SkillResourceSummary {
  readonly path: string
  readonly sizeBytes?: number
  readonly sizeChars?: number
}

export interface SkillDefinitionInput {
  readonly id: string
  readonly name?: string
  readonly description: string
  readonly whenToUse?: string
  readonly instructions: string
  readonly resources?: Readonly<Record<string, string>>
  readonly resourceManifest?: readonly SkillResourceSummary[]
  readonly invocation?: Partial<SkillInvocationPolicy>
  readonly source?: string
  readonly provider?: string
  readonly resourceBase?: SkillResourceBase
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface SkillDefinition {
  readonly kind: 'skill'
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly instructions: string
  readonly resources: Readonly<Record<string, string>>
  readonly resourceManifest: readonly SkillResourceSummary[]
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type SkillSummary = Omit<
  SkillDefinition,
  'kind' | 'instructions' | 'resources' | 'resourceManifest' | 'path' | 'metadata'
>

export interface SkillCandidate extends SkillSummary {
  readonly locator?: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** JSON-safe lightweight candidate used by the versioned package-plugin protocol. */
export interface RuntimeSkillCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation?: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly locator?: JsonValue
}

export interface SkillCatalogSnapshot {
  readonly revision: string
  readonly candidates: readonly RuntimeSkillCandidate[]
}

/** Provider-issued, JSON-safe exact reference persisted across session resume. */
export interface SkillReference {
  readonly id: string
  readonly source: string
  readonly provider: string
  readonly catalogRevision: string
  readonly locator?: JsonValue
}

export interface SkillLookupOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
}

export interface SkillProviderListOptions extends SkillLookupOptions {
  readonly allowedSkillIds?: readonly string[]
}

export type RuntimeSkillLookupOptions = Omit<SkillLookupOptions, 'signal'> & {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

/** Preserved marker-free advanced provider contract. */
export interface SkillProvider {
  readonly kind: 'skill-provider'
  readonly id: string
  list(options: SkillProviderListOptions): Promise<readonly SkillCandidate[]>
  load(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinitionInput | undefined>
  readResource?(
    candidate: SkillCandidate,
    path: string,
    options: SkillLookupOptions,
  ): Promise<string | undefined>
}

/** Recommended independently-versioned provider used by AgentRuntime. */
export interface SkillProviderPlugin {
  readonly kind: 'skill-provider'
  readonly apiVersion: typeof SKILL_PROVIDER_API_VERSION
  readonly id: string
  readonly list: (options: RuntimeSkillLookupOptions & {
    readonly allowedSkillIds?: readonly string[]
  }) => Promise<SkillCatalogSnapshot>
  readonly load: (
    reference: SkillReference,
    options: RuntimeSkillLookupOptions,
  ) => Promise<SkillDefinitionInput | undefined>
  readonly readResource?: (
    reference: SkillReference,
    path: string,
    options: RuntimeSkillLookupOptions,
  ) => Promise<string | undefined>
}

export type SkillProviderPluginDefinition = Omit<
  SkillProviderPlugin,
  'kind' | 'apiVersion'
>
export type SkillProviderDefinition = SkillProviderPluginDefinition

export type SkillSource = SkillDefinition | SkillProvider
export type RuntimeSkillSource = SkillSource | SkillProviderPlugin

export declare function defineSkill(input: SkillDefinitionInput): SkillDefinition
export declare function defineSkillProvider(provider: SkillProvider): SkillProvider
export declare function defineSkillProviderPlugin(
  provider: SkillProviderPluginDefinition,
): SkillProviderPlugin
export declare function validateSkillSource(source: SkillSource): void
export declare function validateSkillId(id: string, label?: string): void
export declare function validateCandidate(candidate: SkillCandidate, providerId: string): void
export declare function validateSkillResourcePath(path: string, skillId: string): void

export interface SkillCatalogOptions {
  readonly allowedSkillIds?: readonly string[]
  readonly maxSkills?: number
  readonly maxCatalogBytes?: number
}

export declare class SkillCatalog {
  constructor(sources: readonly RuntimeSkillSource[], options?: SkillCatalogOptions)
  discover(options?: SkillLookupOptions): Promise<readonly SkillSummary[]>
  summaries(): readonly SkillSummary[]
  load(id: string, options?: SkillLookupOptions): Promise<SkillDefinition | undefined>
  activate(id: string, options?: SkillLookupOptions): Promise<SkillDefinition | undefined>
  isActivated(id: string): boolean
  activatedResources(id: string): readonly SkillResourceSummary[] | undefined
  activatedSummaries(): readonly SkillSummary[]
  clearActivations(): void
  readResource(
    id: string,
    path: string,
    options?: SkillLookupOptions,
  ): Promise<string | undefined>
}

export declare const SKILL_TOOL_NAMES: readonly [
  'load_skill',
  'search_skill_resources',
  'read_skill_resource',
]

export interface AgentSkillOptions {
  readonly maxCatalogChars?: number
  readonly searchLimit?: number
  readonly maxWholeResourceChars?: number
  readonly maxManifestChars?: number
  readonly maxSearchResultChars?: number
  readonly maxSearchResources?: number
  readonly maxSearchInputChars?: number
  readonly operationTimeoutMs?: number
  readonly maxSkills?: number
  readonly maxDiscoveryBytes?: number
}

export interface ResolvedAgentSkillOptions {
  readonly maxCatalogChars: number
  readonly searchLimit: number
  readonly maxWholeResourceChars: number
  readonly maxManifestChars: number
  readonly maxSearchResultChars: number
  readonly maxSearchResources: number
  readonly maxSearchInputChars: number
  readonly operationTimeoutMs: number
  readonly maxSkills: number
  readonly maxDiscoveryBytes: number
}

export declare function resolveSkillOptions(
  input: AgentSkillOptions | undefined,
): ResolvedAgentSkillOptions
export declare function renderSkillCatalog(
  instructions: string,
  summaries: readonly SkillSummary[],
  options: ResolvedAgentSkillOptions,
): string
export declare function createSkillTools(
  catalog: SkillCatalog,
  options: ResolvedAgentSkillOptions,
  lookup: () => SkillLookupOptions,
): readonly ToolDefinition<any>[]

export type AgentMemoryKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'progress'
  | 'next-step'

export interface AgentMemoryItem {
  readonly id: string
  readonly kind: AgentMemoryKind
  readonly content: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AgentMemorySnapshot {
  readonly version: 1
  readonly items: readonly AgentMemoryItem[]
}

export interface AgentMemorySeed {
  readonly id?: string
  readonly kind: AgentMemoryKind
  readonly content: string
}

export interface AgentMemoryConfigInput {
  readonly autoCaptureObjective?: boolean
  readonly maxInjectedChars?: number
  readonly maxItems?: number
  readonly maxItemChars?: number
  readonly maxStoredChars?: number
  readonly seed?: readonly AgentMemorySeed[]
}

export interface AgentMemoryConfig {
  readonly autoCaptureObjective: boolean
  readonly maxInjectedChars: number
  readonly maxItems: number
  readonly maxItemChars: number
  readonly maxStoredChars: number
  readonly seed: readonly AgentMemorySeed[]
}

export declare class AgentMemory {
  constructor(
    seed?: readonly AgentMemorySeed[],
    limits?: Partial<Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>>,
  )
  static fromSnapshot(
    snapshot: AgentMemorySnapshot,
    limits?: Partial<Pick<AgentMemoryConfig, 'maxItems' | 'maxItemChars' | 'maxStoredChars'>>,
  ): AgentMemory
  remember(input: AgentMemorySeed): AgentMemoryItem
  forget(id: string): boolean
  items(): readonly AgentMemoryItem[]
  snapshot(): AgentMemorySnapshot
  captureOriginalObjective(message: UserMessage): AgentMemoryItem | undefined
  render(maxChars?: number): string
}

export declare function resolveMemoryConfig(
  input: AgentMemoryConfigInput | undefined,
): AgentMemoryConfig

export interface MemoryStoreOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface MemoryLoadResult {
  readonly snapshot: AgentMemorySnapshot
  readonly revision: string
}

export interface MemoryCommitInput {
  readonly key: string
  readonly snapshot: AgentMemorySnapshot
  /** Null means create-only; a string means compare-and-swap replacement. */
  readonly expectedRevision: string | null
}

export interface MemoryCommitResult {
  readonly revision: string
}

export interface MemoryStore {
  readonly kind: 'memory-store'
  readonly apiVersion: typeof MEMORY_STORE_API_VERSION
  readonly id: string
  readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>
  readonly commit: (input: MemoryCommitInput, options: MemoryStoreOptions) => Promise<MemoryCommitResult>
}

export type MemoryStoreDefinition = Omit<MemoryStore, 'kind' | 'apiVersion'>
export declare function defineMemoryStore(definition: MemoryStoreDefinition): MemoryStore

export type MemoryScope =
  | {
    readonly kind: 'conversation'
    readonly namespace: string
  }
  | {
    readonly kind: 'fixed'
    readonly key: string
    readonly sharedAcrossSessions: true
  }

export interface MemoryBinding {
  /** Memory stores are shared/borrowed; the caller owns any store lifecycle. */
  readonly store: MemoryStore
  /** Support-safe identity persisted in snapshots; never derived from the key. */
  readonly bindingId: string
  readonly scope: MemoryScope
  readonly requirement: 'required' | 'best-effort'
}

export type UsageCoverage = 'complete' | 'partial' | 'missing' | 'estimated' | 'not-applicable'

export interface UsageCounters {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

type UsageCounterKey = keyof UsageCounters

export interface UsageValidationResult {
  readonly reported: UsageCounters
  readonly invalidFields: readonly UsageCounterKey[]
  readonly complete: boolean
  readonly overflow: boolean
}

export declare function validateUsageCounters(
  value: unknown,
  normalizedProviderReport?: boolean,
): UsageValidationResult

export interface UsageAdditionResult {
  readonly counters: UsageCounters
  readonly overflow: boolean
}

export declare function addUsageCounters(
  values: readonly UsageCounters[],
): UsageAdditionResult
export declare function hasUsageCounters(value: UsageCounters | undefined): boolean

export type DispatchState = 'not-sent' | 'sent' | 'unknown'
export type OperationStatus = 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'

export interface UsageCoverageSummary {
  readonly logicalCalls: number
  readonly attempts: number
  readonly complete: number
  readonly partial: number
  readonly estimated: number
  readonly missing: number
  readonly notApplicable: number
  readonly possiblyBilledAttemptsWithoutUsage: number
}

export interface AttemptUsageReport {
  readonly attemptId: string
  readonly spanId: SpanId
  readonly attemptNumber: number
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly dispatchState: DispatchState
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly origin?: string
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly error?: SafeErrorRecord
}

export declare function classifyUsageCoverage(
  attempts: readonly Pick<AttemptUsageReport, 'dispatchState' | 'coverage' | 'reported'>[],
  estimated?: UsageCounters,
): UsageCoverage
export declare function possiblyBilledAttemptsWithoutUsage(
  attempts: readonly Pick<AttemptUsageReport, 'dispatchState' | 'reported'>[],
): number

export interface ModelCallReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly modelCallId: string
  readonly spanId: SpanId
  readonly provider: string
  readonly providerFamily?: string
  readonly providerPluginId?: string
  readonly model: string
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly finishReason?: string
  readonly dispatchState?: DispatchState
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly attempts: readonly AttemptUsageReport[]
  readonly possiblyBilledAttemptsWithoutUsage: number
  readonly authoritative: boolean
  readonly delivery: ObservationDeliverySummary
  readonly error?: SafeErrorRecord
}

export interface ModelCallHandle extends AsyncIterable<StreamChunk> {
  readonly runId: string
  readonly modelCallId: string
  readonly report: Promise<ModelCallReport>
}

export declare const OBSERVATION_ERROR_CODES: Readonly<{
  readonly AUDIT_UNAVAILABLE: 'OBSERVABILITY_AUDIT_UNAVAILABLE'
  readonly CAPTURE_REJECTED: 'OBSERVABILITY_CAPTURE_REJECTED'
  readonly PROCESSOR_FAILED: 'OBSERVABILITY_PROCESSOR_FAILED'
  readonly EXPORT_FAILED: 'OBSERVABILITY_EXPORT_FAILED'
  readonly FLUSH_TIMEOUT: 'OBSERVABILITY_FLUSH_TIMEOUT'
  readonly JOURNAL_CORRUPT: 'OBSERVABILITY_JOURNAL_CORRUPT'
  readonly JOURNAL_IO: 'OBSERVABILITY_JOURNAL_IO'
  readonly BROWSER_QUOTA: 'OBSERVABILITY_BROWSER_QUOTA'
  readonly OTEL_PROVIDER_UNCONFIGURED: 'OTEL_PROVIDER_UNCONFIGURED'
  readonly OPERATION_TERMINAL_MISSING: 'OPERATION_TERMINAL_MISSING'
  readonly LEDGER_LIMIT_EXCEEDED: 'LEDGER_LIMIT_EXCEEDED'
  readonly USAGE_MISSING: 'USAGE_MISSING'
  readonly USAGE_REQUIRED: 'USAGE_REQUIRED'
  readonly USAGE_INVALID: 'USAGE_INVALID'
  readonly USAGE_COUNTER_OVERFLOW: 'USAGE_COUNTER_OVERFLOW'
}>

export declare class ModelCallObservationError extends AgentSdkError {
  readonly runId: string
  readonly modelCallId: string
  readonly traceId: TraceId
  readonly report: ModelCallReport
  constructor(message: string, report: ModelCallReport, options?: ErrorOptions)
}

export interface RunUsageReport {
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly coverage: UsageCoverageSummary
  readonly authoritative: boolean
}

export interface UsageEstimationRequest {
  readonly system?: string
  readonly messages: readonly unknown[]
  readonly tools?: readonly ToolSchema[]
}

/** Local-only input; core never retains or exports the request field. */
export interface UsageEstimationInput {
  readonly runId: string
  readonly modelCallId: string
  readonly provider: string
  readonly model: string
  readonly request: GenerateOptions
  readonly report: ModelCallReport
}

export interface UsageEstimator {
  readonly id: string
  readonly estimate: (input: UsageEstimationInput) => UsageCounters | Promise<UsageCounters>
}

export interface UsagePolicy {
  readonly onMissing?: 'warn' | 'estimate' | 'fail'
  readonly estimator?: UsageEstimator
}

export type TrackedOperationKind =
  | 'turn'
  | 'model-call'
  | 'provider-attempt'
  | 'tool'
  | 'compaction'
  | 'hook'
  | 'user-input'
  | 'skill'
  | 'memory'
  | 'credential'
  | 'integration'

export interface RunOperationCounts {
  readonly total: number
  readonly success: number
  readonly error: number
  readonly aborted: number
  readonly rejected: number
  readonly unknown: number
}

export interface RunLedgerLimits {
  readonly maxModelCalls?: number
  readonly maxAttemptsPerCall?: number
  readonly maxToolCalls?: number
  readonly maxSerializedBytes?: number
}

export interface ModelCallPolicyDecision {
  readonly report: ModelCallReport
  readonly usageRequired: boolean
  readonly usageUnavailable: boolean
}

export interface RunAccountingPort {
  readonly runId: string
  readonly traceId: string
  readonly modelInvocation: ModelInvocationContext
  startOperation(
    kind: TrackedOperationKind,
    input?: {
      readonly operationId?: string
      readonly data?: JsonObject
      readonly toolCallId?: string
    },
  ): string
  endOperation(
    operationId: string,
    status: OperationStatus,
    input?: { readonly data?: JsonObject; readonly error?: unknown },
  ): void
  recordModelCall(
    report: ModelCallReport,
    request: GenerateOptions,
  ): Promise<ModelCallPolicyDecision>
  recordError(error: unknown): void
  finalize(
    status: OperationStatus,
    completed: boolean,
    error?: unknown,
  ): Promise<RunReport>
}

export declare const AGENT_ACCOUNTING_ERROR_CODES: Readonly<{
  readonly RUN_FAILED: 'AGENT_RUN_FAILED'
  readonly LEDGER_STATE_INVALID: 'LEDGER_STATE_INVALID'
}>

export declare class AgentRunError extends AgentSdkError {
  readonly runId: string
  readonly traceId: TraceId
  readonly report: RunReport
  constructor(message: string, code: string, report: RunReport, options?: ErrorOptions)
}

export declare function summarizeModelCallUsage(
  reports: readonly ModelCallReport[],
): RunUsageReport
export declare function authoritativeTokenUsage(
  report: RunUsageReport,
): TokenUsage | undefined
export declare function budgetTokenTotal(report: RunUsageReport): number | undefined

export interface TraceRef {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
}

export type AgentSpanKind = 'invoke_agent' | 'chat' | 'execute_tool' | 'compact'
export type AgentSpanStatus = 'success' | 'error' | 'aborted' | 'unknown'

export interface TraceSpanStart {
  readonly type: 'span-start'
  readonly trace: TraceRef
  readonly at: string
  readonly name: string
  readonly kind: AgentSpanKind
  readonly attributes?: Readonly<Record<string, unknown>>
}

export interface TraceSpanEnd {
  readonly type: 'span-end'
  readonly trace: TraceRef
  readonly at: string
  readonly status: AgentSpanStatus
  readonly output?: unknown
  readonly usage?: TokenUsage
  readonly error?: { readonly type: string; readonly message: string; readonly code?: string }
}

export type TraceEvent = TraceSpanStart | TraceSpanEnd

export interface AgentProcessSpan {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly name: string
  readonly kind: AgentSpanKind
  readonly startedAt: string
  readonly durationMs: number | null
  readonly status: AgentSpanStatus
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly output?: unknown
  readonly usage?: TokenUsage
  readonly error?: TraceSpanEnd['error']
  readonly children: readonly AgentProcessSpan[]
}

export declare function buildTraceTree(
  events: readonly TraceEvent[],
): readonly AgentProcessSpan[]

export type DeliveryMode = 'operational' | 'reliable' | 'audit'

export interface SafeErrorRecord {
  readonly type: string
  readonly message: string
  readonly code?: string
  readonly retryable?: boolean
  readonly status?: number
  readonly causeTypes?: readonly string[]
  readonly stack?: string
}

export declare function safeErrorRecord(value: unknown, includeStack?: boolean): SafeErrorRecord

export interface ObservationDeliverySummary {
  readonly mode: DeliveryMode
  readonly requiredBoundary: ObservationBoundary
  readonly reachedBoundary: ObservationBoundary
  readonly complete: boolean
  readonly acceptedCritical: number
  readonly rejectedCritical: number
  readonly pendingCritical: number
  readonly lastFailure?: SafeErrorRecord
}

export type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'

export interface CaptureReceipt {
  readonly eventId: string
  readonly status: 'accepted' | 'rejected' | 'disabled'
  readonly durable: boolean
  readonly boundary: ObservationBoundary
  readonly reason?: 'capacity' | 'closed' | 'processor-failed' | 'exporter-unavailable'
}

export declare function validateCaptureReceipt(value: unknown, eventId: string): CaptureReceipt

export interface ObservationPort {
  readonly mode: DeliveryMode
  openSpan(input: OpenObservationSpanInput): ObservationSpan
  capture(event: ObservationEvent): CaptureReceipt
  checkpoint?(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt>
}

export declare function disabledDeliverySummary(): ObservationDeliverySummary
export declare const NOOP_OBSERVATION_PORT: ObservationPort

/** Immutable accounting/lifecycle record staged before its own delivery checkpoint. */
export interface RunTerminalRecord {
  readonly kind: 'run-terminal-record'
  readonly runId: string
  readonly traceId: string
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly status: OperationStatus
  readonly usage: RunUsageReport
  readonly modelCalls: readonly ModelCallReport[]
  readonly toolSourceSnapshots: readonly ToolSourceRunReference[]
  readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>
  readonly errors: readonly SupportSafeError[]
}

export interface ToolSourceRunReference {
  readonly sourceId: string
  readonly revision: string
}

/** Caller-facing report finalized after the terminal record delivery checkpoint. */
export interface RunReport extends RunTerminalRecord {
  readonly delivery: ObservationDeliverySummary
}

export type ObservationPriority = 'critical' | 'normal' | 'verbose'
export type ObservationPhase = 'start' | 'end' | 'point'
export type ObservationEventName =
  | ObservationSpanName
  | 'sdk.provider.retry.scheduled'
  | 'sdk.observer.failure'
  | 'sdk.exporter.state'
  | 'sdk.log'

export interface ObservationResourceInput {
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly environment?: string
  readonly attributes?: Readonly<Record<string, JsonValue>>
}

/** Existing resource identity stays canonical; new runtime metadata is additive. */
export interface ObservationResource {
  readonly sdkName: 'ai-agent-sdk'
  readonly sdkVersion: string
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly runtime: 'browser' | 'edge' | 'node' | 'unknown'
  readonly runtimeId?: string
  readonly environment?: string
  readonly attributes?: Readonly<Record<string, JsonValue>>
}

export interface ObservationEvent<
  Name extends ObservationEventName = ObservationEventName,
  Data extends JsonObject = JsonObject,
> {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly name: Name
  readonly phase: ObservationPhase
  readonly occurredAt: string
  readonly monotonicMs: number
  readonly priority: ObservationPriority
  readonly resource: ObservationResource
  readonly correlation: CorrelationContext
  readonly data: Data
}

/** Preserved advanced observation-bus batch. */
export interface ObservationBatch {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly createdAt: string
  readonly events: readonly ObservationEvent[]
}

/** Runtime plugin delivery includes atomic per-run terminal records. */
export interface ObservationDeliveryBatch {
  readonly id: string
  readonly resource: ObservationResource
  readonly events: readonly ObservationEvent[]
  /**
   * Atomic terminal records included in this delivery batch. A batch can contain
   * events from many runs and one run can span batches, so usage is never a
   * batch-level scalar. Each runId appears at most once in this array.
   */
  readonly runRecords: readonly RunTerminalRecord[]
}

export interface ExportAck {
  readonly batchId: string
  readonly accepted: boolean
  readonly retryable: boolean
}

export interface ObservationDeliveryAck {
  readonly batchId: string
  readonly acceptedEventIds: readonly string[]
  readonly acceptedRunIds: readonly string[]
}

export type ObservationExportItem = ObservationEvent | RunTerminalRecord

/** Preserved advanced bus exporter; marker-free and caller-owned. */
export interface ObservationExporter {
  readonly id: string
  readonly supportedBoundaries?: readonly ObservationBoundary[]
  stage?(event: ObservationEvent): void | Promise<void>
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  shutdown?(signal: AbortSignal): Promise<void>
}

export interface ObservationExporterRegistration {
  readonly exporter: ObservationExporter
  readonly requirement: 'required' | 'best-effort'
  readonly boundary: ObservationBoundary
}

/** Recommended runtime plugin with explicit marker, readiness and ownership. */
export interface ObservationExporterPlugin {
  readonly kind: 'observation-exporter'
  readonly apiVersion: typeof OBSERVATION_EXPORTER_API_VERSION
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  readonly ready?: (signal: AbortSignal) => Promise<void>
  readonly stage?: (item: ObservationExportItem) => void | Promise<void>
  readonly export: (
    batch: ObservationDeliveryBatch,
    signal: AbortSignal,
  ) => Promise<ObservationDeliveryAck>
  readonly shutdown?: (signal: AbortSignal) => Promise<void>
}

export type ObservationExporterPluginDefinition = Omit<
  ObservationExporterPlugin,
  'kind' | 'apiVersion'
>
export declare function defineObservationExporter(
  definition: ObservationExporterPluginDefinition,
): ObservationExporterPlugin

export interface RuntimeObservationExporterRegistration {
  readonly exporter: ObservationExporterPlugin
  readonly ownership: 'borrowed' | 'owned'
  readonly requirement: 'required' | 'best-effort'
  readonly boundary: ObservationBoundary
}

export interface AgentRuntimeOptions {
  readonly providers: readonly ComposableModelProviderPlugin[]
  /** Route used when an agent omits model; never a provider family or array index. */
  readonly defaultProvider?: string
  readonly signal?: AbortSignal
  readonly resource?: ObservationResourceInput
  readonly observability?: {
    /** Explicit delivery contract; omission selects operational best-effort delivery. */
    readonly mode?: DeliveryMode
    readonly content?: 'none' | 'metadata'
    readonly minimumLogLevel?: LogLevel
    readonly exporters?: readonly RuntimeObservationExporterRegistration[]
    readonly processors?: readonly ObservationProcessor[]
    readonly redactors?: readonly ContentRedactor[]
    readonly includeErrorStacks?: boolean
    readonly openSpan?: (input: OpenObservationSpanInput) => ObservationSpan
    readonly maxQueueEvents?: number
    readonly maxQueueBytes?: number
    readonly maxBatchEvents?: number
    readonly maxBatchBytes?: number
    readonly flushTimeoutMs?: number
    readonly shutdownTimeoutMs?: number
  }
  readonly closeTimeoutMs?: number
  readonly startupTimeoutMs?: number
  readonly diagnosticMaxEvents?: number
  readonly diagnosticMaxBytes?: number
}

export type ObservationContentPolicy = 'none' | 'metadata' | 'redacted' | 'full'

export interface FlushResult {
  readonly complete: boolean
  readonly exportedEvents: number
  readonly pendingEvents: number
  readonly rejectedCritical: number
  readonly timedOut: boolean
}

export interface ObservationHealthSnapshot {
  readonly state: 'disabled' | 'healthy' | 'degraded' | 'failed' | 'closed'
  readonly queuedEvents: number
  readonly queuedBytes: number
  readonly accepted: number
  readonly exported: number
  readonly droppedVerbose: number
  readonly droppedNormal: number
  readonly criticalRejected: number
  readonly processorFailures: number
  readonly exporterFailures: number
  readonly flushTimeouts: number
  readonly lastExportAt?: string
  readonly lastFailure?: SafeErrorRecord
}

/** Additive runtime projection; the preserved advanced health shape is unchanged. */
export interface RuntimeObservationHealthSnapshot extends ObservationHealthSnapshot {
  readonly integrationEvidence: {
    readonly accepted: number
    readonly filtered: number
    readonly dropped: number
    readonly rejected: number
  }
}

export interface LoggerContext {
  readonly invocation?: Pick<ModelInvocationContext, 'correlation' | 'resource' | 'scope'>
  readonly correlation?: CorrelationContext
  readonly resource?: ObservationResource
  readonly fields?: Readonly<JsonObject>
}

export interface ObservabilityOptions {
  readonly mode?: ObservationPort['mode']
  readonly resource?: Partial<Omit<ObservationResource, 'sdkName'>>
  readonly exporters?: readonly ObservationExporterRegistration[]
  readonly processors?: readonly ObservationProcessor[]
  readonly content?: ObservationContentPolicy
  readonly redactors?: readonly ContentRedactor[]
  readonly includeErrorStacks?: boolean
  readonly minimumLogLevel?: LogLevel
  readonly maxQueueEvents?: number
  readonly maxQueueBytes?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
  readonly flushTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly onHealthChange?: (health: ObservationHealthSnapshot) => void
  readonly openSpan?: ObservationPort['openSpan']
}

export interface Observability extends ObservationPort {
  readonly resource: ObservationResource
  checkpoint(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt>
  logger(context?: LoggerContext): SdkLogger
  health(): ObservationHealthSnapshot
  flush(signal?: AbortSignal): Promise<FlushResult>
  shutdown(signal?: AbortSignal): Promise<FlushResult>
}

export interface TraceProjection {
  readonly eventId: string
  readonly name: string
  readonly phase: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly status?: string
  readonly durationMs?: number
}

export interface LogProjection {
  readonly eventId: string
  readonly level: LogLevel
  readonly message: string
  readonly fields: JsonObject
  readonly traceId: string
  readonly spanId: string
}

export interface MetricProjection {
  readonly name: string
  readonly value: number
  readonly attributes: JsonObject
}

export declare function createObservability(options?: ObservabilityOptions): Observability

export declare class MemoryObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ['none']
  private readonly retained
  private readonly retainedBatches
  constructor(id?: string)
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  events(): readonly ObservationEvent[]
  batches(): readonly ObservationBatch[]
  clear(): void
}

export interface TestObservationExporterOptions {
  readonly id?: string
  readonly supportedBoundaries?: readonly ObservationBoundary[]
  readonly failExports?: number
  readonly retryable?: boolean
  readonly rejectAck?: boolean
}

export declare class TestObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  readonly exported: ObservationBatch[]
  shutdownCalls: number
  private failuresRemaining
  private readonly retryable
  private readonly rejectAck
  constructor(options?: TestObservationExporterOptions)
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  shutdown(signal: AbortSignal): Promise<void>
}

export declare function projectTrace(event: ObservationEvent): TraceProjection | undefined
export declare function projectLog(event: ObservationEvent): LogProjection | undefined
export declare function projectMetrics(event: ObservationEvent): readonly MetricProjection[]

export interface UserInputOption {
  readonly label: string
  readonly description: string
}

export interface UserInputQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly UserInputOption[]
  readonly allowFreeForm: true
}

export interface UserInputRequest {
  readonly requestId: string
  readonly callId: string
  readonly turn: number
  readonly step: number
  readonly questions: readonly UserInputQuestion[]
  readonly isBlocking: true
}

export interface UserInputAnswer {
  readonly answers: readonly string[]
}

export interface UserInputResponse {
  readonly answers: Readonly<Record<string, UserInputAnswer>>
}

export type UserInputDecision = UserInputResponse | 'abort'

export interface UserInputBroker {
  readonly request: (
    request: UserInputRequest,
    signal?: AbortSignal,
  ) => Promise<UserInputDecision>
}

export interface InteractiveUserInputBroker extends UserInputBroker {
  readonly pending: () => readonly UserInputRequest[]
  readonly onRequest: (listener: (request: UserInputRequest) => void) => () => void
  readonly resolve: (requestId: string, response: UserInputResponse) => boolean
  readonly abortAll: () => void
}

export declare function fixedUserInputBroker(
  response: UserInputResponse | (
    (request: UserInputRequest) => UserInputDecision | Promise<UserInputDecision>
  ),
): UserInputBroker
export declare function createUserInputBroker(
  options?: InteractiveUserInputBrokerOptions,
): InteractiveUserInputBroker

export interface TurnHookContext {
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly snapshot: RuntimeAgentSessionSnapshot
  /** Always present on AgentRuntime execution paths; optional for legacy low-level callers. */
  readonly logger?: SdkLogger
}

type CompactionTrigger = 'pressure' | 'context-overflow' | 'manual'
type AgentMaintenanceEvent =
  | {
    readonly type: 'compaction-start'
    readonly compactionId: string
    readonly trigger: CompactionTrigger
    readonly estimatedInputTokens: number
  }
  | {
    readonly type: 'compaction-end'
    readonly compactionId: string
    readonly trigger: CompactionTrigger
    readonly status: 'completed' | 'failed'
    readonly shadowedSeqs: readonly number[]
    readonly estimatedTokensBefore: number
    readonly estimatedTokensAfter: number
    readonly thresholdTokens?: number
    readonly estimatedNonCompactableTokens?: number
    readonly backoffReason?: CompactionBackoffReason
    readonly cooldownSteps?: number
    readonly summary?: string
    readonly error?: string
    readonly usage?: TokenUsage
  }

export interface BeforeStepContext {
  readonly turn: number
  readonly step: number
  readonly messages: readonly Message[]
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  emit(event: AgentMaintenanceEvent): Promise<void>
}

export type StepDecision =
  | { readonly kind: 'proceed'; readonly prepend?: readonly Message[] }
  | { readonly kind: 'reject'; readonly reason: string }

export interface RequestErrorContext {
  readonly turn: number
  readonly step: number
  readonly failure: ModelFailure
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  emit(event: AgentMaintenanceEvent): Promise<void>
}

export type CheckpointContext =
  | {
    readonly kind: 'before-model-request'
    readonly request: GenerateOptions
    readonly snapshot: HistorySnapshot
    readonly signal?: AbortSignal
    readonly logger?: SdkLogger
  }
  | {
    readonly kind: 'before-tool-dispatch'
    readonly call: ToolCallRequest
    readonly snapshot: HistorySnapshot
    readonly signal?: AbortSignal
    readonly logger?: SdkLogger
  }

export interface TurnEndContext {
  readonly outcome: TurnOutcome
  readonly snapshot: HistorySnapshot
  readonly canContinue: boolean
  readonly logger?: SdkLogger
}

export interface TurnHooks {
  readonly beforeStep?: (
    context: BeforeStepContext,
  ) => Promise<StepDecision> | StepDecision
  readonly onRequestError?: (
    context: RequestErrorContext,
  ) => Promise<'retry' | 'fail'> | 'retry' | 'fail'
  readonly checkpoint?: (context: CheckpointContext) => Promise<void> | void
  readonly onTurnEnd?: (context: TurnEndContext) => Promise<void> | void
}

export interface TurnBounds {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly onExhausted: 'force-final-answer' | 'stop'
  readonly maxConsecutiveToolErrors: number
  readonly repeatToolWarningAt: number
  readonly repeatToolLimit: number
  readonly toolCycleWarningAt: number
  readonly toolCycleLimit: number
  readonly maxToolCycleLength: number
  readonly maxTotalTokens: number
  readonly maxParallel: number
  readonly maxToolResultBytes: number
  readonly maxToolDurationMs: number
  readonly toolTeardownTimeoutMs: number
}

export type ExhaustedBudget =
  | 'steps'
  | 'tool-calls'
  | 'consecutive-tool-errors'
  | 'repeated-tool-call'
  | 'tool-call-cycle'
  | 'tokens'

export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'concluded-by-tool'; readonly toolName: string }
  | {
    readonly kind: 'budget-exhausted'
    readonly budget: ExhaustedBudget
    readonly forcedFinalAnswer: boolean
  }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'usage-unavailable'; readonly modelCallId: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly failure: ModelFailure }

export interface TurnOutcome {
  readonly reason: TurnEndReason
  readonly text: string
  readonly steps: number
  readonly usage?: TokenUsage
  readonly usageReport: RunUsageReport
  readonly toolCalls: number
  readonly traceId: string
}

export type AssistantContentTiming =
  | 'standalone'
  | 'before-tools'
  | 'after-tools'
  | 'between-tools'
export type StreamedAssistantTextPhase = AssistantTextPhase | 'unknown'

interface TracedAgentEvent { readonly trace: TraceRef }

export type AgentEvent = TraceEvent
  | (AgentMaintenanceEvent & TracedAgentEvent)
  | ({ readonly type: 'turn-start'; readonly turn: number } & TracedAgentEvent)
  | ({
    readonly type: 'step-start'
    readonly turn: number
    readonly step: number
    readonly forcedFinal?: true
  } & TracedAgentEvent)
  | ({
    readonly type: 'text-delta'
    readonly index: number
    readonly text: string
    readonly phase: StreamedAssistantTextPhase
  } & TracedAgentEvent)
  | ({ readonly type: 'reasoning-delta'; readonly index: number; readonly text: string } & TracedAgentEvent)
  | ({
    readonly type: 'image-delta'
    readonly itemId: string
    readonly data: string
    readonly mediaType: ImageMediaType
    readonly partialIndex?: number
  } & TracedAgentEvent)
  | ({ readonly type: 'assistant-message'; readonly message: Message } & TracedAgentEvent)
  | ({
    readonly type: 'assistant-text'
    readonly messageId: MessageId
    readonly text: string
    readonly phase: AssistantTextPhase
    readonly timing: AssistantContentTiming
    readonly toolCallIds: readonly ToolCallId[]
    readonly afterToolCallIds: readonly ToolCallId[]
  } & TracedAgentEvent)
  | ({
    readonly type: 'assistant-native-tool'
    readonly messageId: MessageId
    readonly call: NativeToolCallBlock
  } & TracedAgentEvent)
  | ({
    readonly type: 'assistant-reasoning'
    readonly messageId: MessageId
    readonly text: string
    readonly timing: AssistantContentTiming
    readonly toolCallIds: readonly ToolCallId[]
    readonly afterToolCallIds: readonly ToolCallId[]
  } & TracedAgentEvent)
  | ({ readonly type: 'tool-call'; readonly call: ToolCallRequest } & TracedAgentEvent)
  | ({
    readonly type: 'tool-result'
    readonly call: ToolCallRequest
    readonly result: ToolExecutionResult
  } & TracedAgentEvent)
  | ({ readonly type: 'approval-request'; readonly request: ApprovalRequest } & TracedAgentEvent)
  | ({ readonly type: 'usage'; readonly usage: TokenUsage } & TracedAgentEvent)
  | ({ readonly type: 'step-end'; readonly turn: number; readonly step: number } & TracedAgentEvent)
  | ({ readonly type: 'turn-end'; readonly outcome: TurnOutcome } & TracedAgentEvent)

export interface RunToolCallsOptions {
  readonly calls: readonly ToolCallRequest[]
  readonly catalog: ToolCatalog
  readonly history: History
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly parentTrace: TraceRef
  readonly maxParallel?: number
  readonly dispatchLimit?: number
  readonly maxResultBytes?: number
  readonly maxDurationMs?: number
  readonly teardownTimeoutMs?: number
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly emit?: (event: AgentEvent) => Promise<void>
  readonly checkpoint?: TurnHooks['checkpoint']
  readonly accounting?: RunAccountingPort
}

export interface ToolCallsOutcome {
  readonly results: readonly ToolExecutionResult[]
  readonly concluded: boolean
  readonly concludedBy?: string
  readonly dispatched: number
}

export declare function runToolCalls(options: RunToolCallsOptions): Promise<ToolCallsOutcome>

export interface RunTurnOptions {
  readonly registry: ModelRegistry
  readonly config: CallConfig
  readonly history: History
  readonly tools?: ToolCatalog
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
  readonly system?: string
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly bounds?: Partial<TurnBounds>
  readonly hooks?: TurnHooks
  readonly signal?: AbortSignal
  readonly teardownTimeoutMs?: number
  readonly modelTimeoutMs?: number
  readonly maxModelRequestBytes?: number
  readonly maxModelResponseBytes?: number
  readonly maxModelStreamEvents?: number
  readonly hookTimeoutMs?: number
  readonly hookTeardownTimeoutMs?: number
  readonly commentary?: 'auto' | 'concise' | 'off'
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
    readonly conversationId?: string
    readonly agentId?: string
    readonly agentName?: string
  }
  readonly accounting?: RunAccountingPort
}

export declare function runTurn(options: RunTurnOptions): AsyncIterable<AgentEvent>

export declare const AGENT_CONTROL_TOOLS: Readonly<{
  readonly complete: 'submit_result'
  readonly requestUserInput: 'request_user_input'
}>

export type AgentMode = 'basic' | 'deep' | 'deep-human-in-loop'

interface AgentRunCommon
  extends Omit<RunTurnOptions, 'bounds' | 'commentary' | 'config' | 'hooks' | 'system' | 'tools'> {
  readonly config: CallConfig
  readonly tools?: ToolCatalog
  readonly system?: string
  readonly maxTurns?: number
  readonly bounds?: Omit<Partial<TurnBounds>, 'maxSteps'>
  readonly commentary?: RunTurnOptions['commentary']
  readonly hooks?: TurnHooks
}

export interface BasicAgentOptions extends AgentRunCommon { readonly mode?: 'basic' }
export interface DeepAgentOptions extends AgentRunCommon {
  readonly mode: 'deep'
  readonly userInput?: UserInputBroker
}
export interface HumanInLoopAgentOptions extends AgentRunCommon {
  readonly mode: 'deep-human-in-loop'
  readonly userInput: UserInputBroker
}
export type RunAgentOptions = BasicAgentOptions | DeepAgentOptions | HumanInLoopAgentOptions

export interface CompletionSubmission {
  readonly summary: string
  readonly evidence: readonly string[]
}

export interface AgentRunOutcome extends TurnOutcome {
  readonly mode: AgentMode
  readonly completed: boolean
  readonly completion?: CompletionSubmission
}

export type AgentRunEvent = AgentEvent
  | { readonly type: 'agent-start'; readonly mode: AgentMode; readonly maxTurns: number }
  | { readonly type: 'user-input-request'; readonly request: UserInputRequest }
  | {
    readonly type: 'user-input-response'
    readonly request: UserInputRequest
    readonly response: UserInputResponse | 'abort'
  }
  | { readonly type: 'agent-end'; readonly outcome: AgentRunOutcome }

export declare function runAgent(options: RunAgentOptions): AsyncIterable<AgentRunEvent>

export interface InteractiveUserInputBrokerOptions { readonly maxPending?: number }

export interface AgentCompactionOptions {
  readonly auto?: boolean
  readonly maxInputTokens?: number
  readonly thresholdRatio?: number
  readonly retainRatio?: number
  readonly retainTokens?: number
  readonly summarizationProvider?: string
  readonly summarizationModel?: string
  readonly summarizationEffort?: string
  readonly maxSummaryTokens?: number
  readonly compactionRetries?: number
  readonly maxOverflowRetries?: number
  readonly maxSummaryInputChars?: number
  readonly maxSummaryRequestChars?: number
  readonly maxSummaryRequestBytes?: number
  readonly maxSummaryResponseBytes?: number
  readonly maxSummaryStreamEvents?: number
  readonly summaryTimeoutMs?: number
  readonly teardownTimeoutMs?: number
  readonly maxToolResultChars?: number
}

export interface AgentCompactionConfig {
  readonly auto: boolean
  readonly maxInputTokens: number | undefined
  readonly thresholdRatio: number
  readonly retainRatio: number | undefined
  readonly retainTokens: number | undefined
  readonly summarizationProvider: string | undefined
  readonly summarizationModel: string | undefined
  readonly summarizationEffort: string | undefined
  readonly maxSummaryTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  readonly maxSummaryInputChars: number
  readonly maxSummaryRequestChars: number
  readonly maxSummaryRequestBytes: number
  readonly maxSummaryResponseBytes: number
  readonly maxSummaryStreamEvents: number
  readonly summaryTimeoutMs: number
  readonly teardownTimeoutMs: number
  readonly maxToolResultChars: number
}

export declare function resolveCompactionConfig(
  input: AgentCompactionOptions | undefined,
): AgentCompactionConfig

export interface AgentDefinitionInput {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly maxTokens?: number
  readonly instructions: string
  readonly mode?: AgentMode
  readonly tools?: readonly ToolDefinition<any>[]
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly skills?: readonly SkillSource[]
  readonly skillIds?: readonly string[]
  readonly skillOptions?: AgentSkillOptions
  readonly toolChoice?: ToolChoice
  readonly maxTurns?: number
  readonly maxToolCalls?: number
  readonly commentary?: 'auto' | 'concise' | 'off'
  readonly memory?: AgentMemoryConfigInput
  readonly compaction?: AgentCompactionOptions | false
}

export interface AgentDefinition {
  readonly id: string
  readonly name: string
  readonly description: string | undefined
  readonly provider: string
  readonly model: string
  readonly effort: ReasoningEffortId
  readonly maxTokens: number | undefined
  readonly instructions: string
  readonly mode: AgentMode
  readonly tools: readonly ToolDefinition<any>[]
  readonly nativeTools: readonly NativeToolSchema[]
  readonly skills: readonly SkillSource[]
  readonly skillIds: readonly string[] | undefined
  readonly skillOptions: ResolvedAgentSkillOptions
  readonly toolChoice: ToolChoice | undefined
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly commentary: 'auto' | 'concise' | 'off'
  readonly memory: AgentMemoryConfig
  readonly compaction: AgentCompactionConfig | false
}

export type AgentDefinitionOverrides = Partial<Omit<AgentDefinitionInput, 'id'>>
export type CloneAgentOverrides = AgentDefinitionOverrides & { readonly id: string }

export interface DefinedAgent extends AgentDefinition {
  createSession(options: AgentSessionOptions): AgentSession
  resumeSession(options: AgentResumeSessionOptions): AgentSession
  with(overrides: AgentDefinitionOverrides): DefinedAgent
}

export declare function defineAgent(input: AgentDefinitionInput): DefinedAgent
export declare function cloneAgent(
  source: AgentDefinition,
  overrides: CloneAgentOverrides,
): DefinedAgent

export interface RuntimeAgentDefinitionInput {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly model: ModelTarget
  readonly instructions: string
  readonly effort?: string
  readonly maxTokens?: number
  readonly mode?: 'basic' | 'deep' | 'deep-human-in-loop'
  readonly tools?: readonly ToolDefinition[]
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
  readonly toolSources?: readonly ToolSource[]
  readonly skills?: readonly RuntimeSkillSource[]
  readonly allowedSkillIds?: readonly string[]
  readonly memory?: MemoryBinding
  readonly compaction?: AgentCompactionOptions | false
  readonly maxTurns?: number
  readonly maxToolCalls?: number
  readonly commentary?: 'auto' | 'concise' | 'off'
}

export interface RuntimeAgentDefinition extends RuntimeAgentDefinitionInput {}

/** Runtime-bound input; reusable defineAgent overloads retain their existing discriminant. */
export interface RuntimeAgentBindingInput extends Omit<RuntimeAgentDefinitionInput, 'model'> {
  /** Full target overrides defaults; route-only selects that provider's configured default. */
  readonly model?: { readonly provider: string; readonly id?: string }
}

export declare function defineAgent(input: RuntimeAgentDefinitionInput): RuntimeAgentDefinition
export declare function cloneAgent(
  source: RuntimeAgentDefinition,
  overrides: Partial<Omit<RuntimeAgentDefinitionInput, 'id'>> & { readonly id: string },
): RuntimeAgentDefinition

export interface RuntimeAgentResponse {
  readonly runId: string
  readonly traceId: string
  readonly text: string
  readonly usage: RunUsageReport
  readonly report: RunReport
}

export interface SupportSafeError {
  readonly code: string
  readonly stage: string
  readonly message: string
  readonly provider?: string
  readonly route?: string
  readonly origin?: string
  readonly status?: number
  readonly requestId?: string
  readonly retryable?: boolean
  readonly dispatchState?: DispatchState
  readonly usageCoverage: UsageCoverageSummary
  readonly possiblyBilledAttemptsWithoutUsage: number
}

export interface RuntimeAgentRunEventContext {
  readonly runId: string
  readonly traceId: string
  readonly sequence: number
}

export type RuntimeAgentRunEvent = RuntimeAgentRunEventContext & (
  | { readonly type: 'commentary-delta'; readonly text: string }
  | { readonly type: 'assistant-delta'; readonly text: string }
  | {
    readonly type: 'tool-call'
    readonly callId: string
    readonly name: string
    readonly input: unknown
  }
  | {
    readonly type: 'tool-result'
    readonly callId: string
    readonly name: string
    readonly status: 'completed' | 'failed' | 'aborted' | 'rejected'
    readonly output: unknown
  }
  | {
    readonly type: 'assistant-native-tool'
    readonly callId: string
    readonly provider: string
    readonly name: string
    readonly status: 'started' | 'completed' | 'failed' | 'unknown'
    readonly input?: JsonValue
    readonly output?: JsonValue
  }
  | { readonly type: 'approval-request'; readonly request: ApprovalRequest }
  | { readonly type: 'user-input-request'; readonly request: UserInputRequest }
  | {
    readonly type: 'user-input-response'
    readonly requestId: string
    readonly response: UserInputDecision
  }
  | { readonly type: 'usage'; readonly usage: RunUsageReport; readonly report: RunReport }
  | { readonly type: 'error'; readonly error: SupportSafeError; readonly report: RunReport }
)

export interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  /** Settles with the canonical terminal report independently of result success. */
  readonly report: Promise<RunReport>
  abort(reason?: unknown): void
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal
  /**
   * Host-selected, run-scoped instructions appended after the immutable agent
   * definition. They are not persisted in history/snapshots and do not change
   * the session or conversation identity. A present value must contain
   * non-whitespace text and encode to at most 65,536 UTF-8 bytes.
   */
  readonly additionalInstructions?: string
}

/** Preserved invocation options for non-stream convenience methods. */
export interface RuntimeAgentInvocationOptions extends AgentRunOptions {
  /**
   * Sequential event observer used by run()/generate(). stream() callers consume
   * the returned handle directly; compact() produces no run events.
   */
  readonly onEvent?: (event: RuntimeAgentRunEvent) => void | Promise<void>
}

export interface RuntimeAgentSessionSnapshot {
  readonly version: 1
  readonly conversationId: string
  readonly agentId: string
  readonly history: HistorySnapshot
  readonly memory: AgentMemorySnapshot
  readonly memoryBindingId?: string
  readonly skills?: {
    readonly activated: readonly ActivatedSkillSnapshot[]
  }
}

export interface HistorySurfaceNode {
  readonly seq: number
  readonly message: Message
}

export type SurfaceOp =
  | 'append'
  | {
    readonly op: 'replace'
    readonly from: number
    readonly to: number
    readonly targets?: readonly number[]
  }

export type CompactionBackoffReason = 'low-savings' | 'unreachable-threshold'

export type HistoryEvent =
  | { readonly kind: 'user'; readonly message: Message }
  | {
    readonly kind: 'assistant'
    readonly message: Message
    readonly interrupted?: true
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'tool-call'
    readonly callId: ToolCallId
    readonly name: string
    readonly rawArguments: string
  }
  | {
    readonly kind: 'tool-result'
    readonly callId: ToolCallId
    readonly message: Message
    readonly result: ToolExecutionResult
  }
  | {
    readonly kind: 'compaction-start'
    readonly compactionId: string
    readonly trigger: 'pressure' | 'context-overflow' | 'manual'
    readonly at: string
  }
  | {
    readonly kind: 'compaction-prune'
    readonly callId: ToolCallId
    readonly originalSeq: number
    readonly charsBefore: number
    readonly charsAfter: number
  }
  | {
    readonly kind: 'compaction-summary'
    readonly compactionId: string
    readonly summary: string
    readonly shadowedSeqs: readonly number[]
    readonly estimatedTokensBefore: number
    readonly estimatedTokensAfter: number
    readonly provider: string
    readonly model: string
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'compaction-end'
    readonly compactionId: string
    readonly status: 'completed' | 'failed'
    readonly at: string
    readonly thresholdTokens?: number
    readonly estimatedNonCompactableTokens?: number
    readonly backoffReason?: CompactionBackoffReason
    readonly cooldownSteps?: number
    readonly error?: string
  }

export interface HistoryEntry {
  readonly seq: number
  readonly event: HistoryEvent
  readonly surfaceOp: SurfaceOp
}

export interface HistorySnapshot {
  readonly version: 1
  readonly entries: readonly HistoryEntry[]
}

export interface HistoryLimits {
  readonly maxEntries?: number
  readonly maxEntryBytes?: number
  readonly maxBytes?: number
}

export declare class History {
  constructor(limits?: HistoryLimits)
  static fromSnapshot(snapshot: HistorySnapshot, limits?: HistoryLimits): History
  append(event: HistoryEvent, surfaceOp?: SurfaceOp): HistoryEntry
  appendBatch(writes: readonly {
    readonly event: HistoryEvent
    readonly surfaceOp?: SurfaceOp
  }[]): readonly HistoryEntry[]
  entries(): readonly HistoryEntry[]
  messages(): readonly Message[]
  surface(): readonly HistorySurfaceNode[]
  generation(): number
  snapshot(): HistorySnapshot
}

export declare function projectMessages(entries: readonly HistoryEntry[]): readonly Message[]
export declare function projectHistorySurface(
  entries: readonly HistoryEntry[],
): readonly HistorySurfaceNode[]
export declare function normalizeToolPairing(
  messages: readonly Message[],
): readonly Message[]
export declare function estimateContextTokens(input: {
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ModelToolSchema[]
}): number
export declare function estimateMessageTokens(message: Message | undefined): number
export declare function selectCompactablePrefix(
  surface: readonly HistorySurfaceNode[],
  retainTokens: number,
): readonly HistorySurfaceNode[]

export interface ActivatedSkillSnapshot extends SkillReference {
  readonly resourceBase?: {
    readonly kind: 'directory' | 'url' | 'opaque'
    readonly value: string
  }
}

export type AgentInput = string | UserMessage

export interface AgentRuntimeLimits {
  readonly teardownTimeoutMs?: number
  readonly modelTimeoutMs?: number
  readonly maxModelRequestBytes?: number
  readonly maxModelResponseBytes?: number
  readonly maxModelStreamEvents?: number
  readonly maxToolResultBytes?: number
  readonly maxToolDurationMs?: number
  readonly toolTeardownTimeoutMs?: number
  readonly maxParallelToolCalls?: number
  readonly maxConsecutiveToolErrors?: number
  readonly repeatToolWarningAt?: number
  readonly repeatToolLimit?: number
  readonly toolCycleWarningAt?: number
  readonly toolCycleLimit?: number
  readonly maxToolCycleLength?: number
  readonly maxTotalTokens?: number
  readonly hookTimeoutMs?: number
  readonly hookTeardownTimeoutMs?: number
  readonly observerTimeoutMs?: number
}

interface AgentSessionActivatedSkillSnapshot {
  readonly id: string
  readonly provider: string
  readonly source: string
  readonly resourceBase?: SkillResourceBase
}

export interface AgentSessionOptions {
  readonly registry: ModelRegistry
  readonly conversationId?: string
  readonly history?: History
  readonly historyLimits?: HistoryLimits
  readonly runtimeLimits?: AgentRuntimeLimits
  readonly tools?: ToolCatalog | readonly ToolDefinition<any>[]
  readonly skills?: readonly SkillSource[]
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly hooks?: TurnHooks
  readonly observation?: ObservationPort
  readonly observationResource?: ObservationResource
  readonly usagePolicy?: UsagePolicy
  readonly ledgerLimits?: RunLedgerLimits
  readonly memory?: AgentMemory | AgentMemorySnapshot
  readonly compaction?: AgentCompactionOptions | false
  readonly trace?: { readonly traceId?: TraceId; readonly parentSpanId?: SpanId }
  readonly team?: AgentTeamMemberOptions
}

export interface AgentSessionSnapshot {
  readonly version: 1
  readonly conversationId: string
  readonly agentId: string
  readonly history: HistorySnapshot
  readonly memory: AgentMemorySnapshot
  readonly skills?: { readonly activated: readonly AgentSessionActivatedSkillSnapshot[] }
}

export interface AgentResumeSessionOptions
  extends Omit<AgentSessionOptions, 'conversationId' | 'history' | 'memory'> {
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentInvocationOptions {
  readonly signal?: AbortSignal
  readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
}

export interface AgentResponse {
  readonly text: string
  readonly outcome: AgentRunOutcome
  readonly report: RunReport
  readonly message?: Message
}

export interface AgentRunHandle extends AsyncIterable<AgentRunEvent> {
  readonly runId: string
  readonly result: Promise<AgentResponse>
  readonly report: Promise<RunReport>
}

export declare class AgentSession {
  readonly definition: AgentDefinition
  constructor(definition: AgentDefinition, options: AgentSessionOptions)
  static fromSnapshot(
    definition: AgentDefinition,
    options: AgentResumeSessionOptions,
  ): AgentSession
  get conversationId(): string
  get history(): History
  get memory(): AgentMemory
  get skills(): SkillCatalog | undefined
  get isRunning(): boolean
  snapshot(): AgentSessionSnapshot
  reset(): void
  compact(invocation?: AgentInvocationOptions): Promise<CompactionResult | null>
  inject(input: AgentInput): number
  whenIdle(signal?: AbortSignal): Promise<void>
  stream(input: AgentInput, invocation?: AgentInvocationOptions): AgentRunHandle
  streamPending(invocation?: AgentInvocationOptions): AgentRunHandle
  run(input: AgentInput, invocation?: AgentInvocationOptions): Promise<AgentResponse>
  runPending(invocation?: AgentInvocationOptions): Promise<AgentResponse>
}

export interface RuntimeAgentLimits {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxConsecutiveToolErrors?: number
  readonly maxTotalTokens?: number
  readonly observerTimeoutMs?: number
}

export interface RuntimeAgentSessionOptions {
  readonly conversationId?: string
  readonly tools?: readonly ToolDefinition[]
  readonly toolSources?: readonly ToolSource[]
  readonly skills?: readonly RuntimeSkillSource[]
  /** Overrides the agent default; false explicitly disables persistent memory. */
  readonly memory?: MemoryBinding | false
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly hooks?: TurnHooks
  readonly usagePolicy?: UsagePolicy
  readonly runtimeLimits?: RuntimeAgentLimits
  readonly compaction?: AgentCompactionOptions | false
}

export interface CompactionResult {
  readonly compactionId: string
  readonly trigger: CompactionTrigger
  readonly summary: string
  readonly shadowedSeqs: readonly number[]
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
  readonly thresholdTokens?: number
  readonly estimatedNonCompactableTokens: number
  readonly backoffReason?: CompactionBackoffReason
  readonly cooldownSteps?: number
  readonly provider: string
  readonly model: string
  readonly usage?: TokenUsage
  /** Additive runtime projection; absent on the preserved low-level compactor path. */
  readonly status?: 'completed'
  readonly report?: RunReport
}

export interface ContextCompactorOptions {
  readonly registry: ModelRegistry
  readonly config: CallConfig
  readonly history: () => History
  readonly system: () => string
  readonly pinnedMessages?: () => readonly Message[]
  readonly tools: () => readonly ModelToolSchema[]
  readonly policy: AgentCompactionConfig
}

export declare const COMPACTION_INSTRUCTION: string

export declare class ContextCompactor {
  constructor(input: ContextCompactorOptions)
  beforeStep(context: BeforeStepContext): Promise<void>
  onRequestError(context: RequestErrorContext): Promise<'retry' | undefined>
  compactNow(signal?: AbortSignal): Promise<CompactionResult | null>
}

export interface RuntimeAgentSession {
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

export interface RuntimeAgent {
  /** Detached, resolved target captured at binding, never changed by provider defaults later. */
  readonly model: ModelTarget
  generate(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  createSession(options?: RuntimeAgentSessionOptions): RuntimeAgentSession
  resumeSession(
    snapshot: RuntimeAgentSessionSnapshot,
    options?: RuntimeAgentSessionOptions,
  ): RuntimeAgentSession
}

export interface TeamMemberAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
}

export interface TeamSessionPort {
  readonly definition: { readonly id: string }
  readonly conversationId: string
  readonly isRunning: boolean
  inject(input: UserMessage): number
  whenIdle(signal?: AbortSignal): Promise<void>
  runPending(invocation?: {
    readonly signal?: AbortSignal
    readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
  }): Promise<unknown>
}

export interface TeamPort {
  attach(session: TeamSessionPort, options?: TeamMemberAttachmentOptions): void
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

interface AgentSessionTeamPort {
  attach(session: AgentSession, options?: TeamMemberAttachmentOptions): void
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

export interface AgentTeamMemberOptions extends TeamMemberAttachmentOptions {
  readonly team: AgentSessionTeamPort
}

export type AgentMessageDelivery = 'quiet' | 'wakeup'

export interface AgentTeamMember {
  readonly name: string
  readonly agentId: string
  readonly kind: 'local' | 'remote'
  readonly conversationId?: string
  readonly role: 'lead' | 'peer'
  readonly status: 'running' | 'idle' | 'failed'
  readonly protocol?: string
  readonly deliveries: readonly AgentMessageDelivery[]
  readonly description?: string
  readonly error?: string
}

export interface LinkedAgentResult {
  readonly kind: 'message' | 'task'
  readonly succeeded: boolean
  readonly text: string
  readonly contextId: string
  readonly taskId?: string
  readonly state?: string
}

export interface LinkedAgentSendInput {
  readonly teamId: string
  readonly messageId: string
  readonly sender: string
  readonly senderAgentId: string
  readonly content: readonly ContentBlock[]
  readonly signal?: AbortSignal
  /** Always set by RuntimeAgentTeam; optional for preserved direct transports. */
  readonly logger?: SdkLogger
}

export interface LinkedAgentTransport {
  readonly protocol: string
  readonly agentId: string
  send(input: LinkedAgentSendInput): Promise<LinkedAgentResult>
}

export interface LinkAgentOptions {
  readonly name: string
  readonly description?: string
  readonly transport: LinkedAgentTransport
}

export interface SendAgentMessageRequest {
  readonly from: string
  readonly target: string
  readonly message: string | readonly ContentBlock[]
  readonly delivery?: AgentMessageDelivery
  readonly signal?: AbortSignal
}

export interface AgentMessageRecord {
  readonly id: string
  readonly teamId: string
  readonly sender: string
  readonly senderAgentId: string
  readonly target: string
  readonly targetAgentId: string
  readonly delivery: AgentMessageDelivery
  readonly content: readonly ContentBlock[]
  readonly status: 'accepted'
  readonly createdAt: string
  readonly result?: LinkedAgentResult
}

export interface SendAgentMessageResult {
  readonly messageId: string
  readonly status: 'accepted'
  readonly delivery: AgentMessageDelivery
  readonly target: string
  readonly result?: LinkedAgentResult
}

export type AgentTeamEvent =
  | { readonly type: 'member-attached'; readonly member: AgentTeamMember }
  | { readonly type: 'member-linked'; readonly member: AgentTeamMember }
  | { readonly type: 'message-accepted'; readonly message: AgentMessageRecord }
  | { readonly type: 'member-run-start'; readonly member: string }
  | { readonly type: 'member-run-end'; readonly member: string }
  | { readonly type: 'member-run-cancelled'; readonly member: string }
  | { readonly type: 'member-run-error'; readonly member: string; readonly error: string }
  | { readonly type: 'team-disposed'; readonly teamId: string }

export interface AgentTeamOptions {
  readonly id?: string
  readonly maxMembers?: number
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  readonly maxLinkedResultBytes?: number
  readonly maxMailboxBytes?: number
  readonly maxMetadataBytes?: number
  readonly disposeTimeoutMs?: number
  readonly operationTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly onEvent?: (event: AgentTeamEvent) => void
  readonly onAgentEvent?: (
    member: string,
    event: AgentRunEvent,
  ) => void | Promise<void>
}

export declare class AgentTeam implements TeamPort {
  readonly id: string
  constructor(options?: AgentTeamOptions)
  attach(session: TeamSessionPort, options?: TeamMemberAttachmentOptions): void
  linkAgent(options: LinkAgentOptions): () => void
  detach(name: string): void
  members(): readonly AgentTeamMember[]
  messages(): readonly AgentMessageRecord[]
  sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult>
  followup(
    from: string,
    target: string,
    message: string | readonly ContentBlock[],
    signal?: AbortSignal,
  ): Promise<SendAgentMessageResult>
  whenIdle(name: string, signal?: AbortSignal): Promise<void>
  cancel(name: string, reason?: unknown): Promise<void>
  dispose(reason?: unknown): Promise<void>
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

type DefinedTeamDetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team'>

export interface DefinedAgentTeamMemberInput {
  readonly agent: DefinedAgent
  readonly name?: string
  readonly description?: string
  readonly collaborationInstructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
  readonly registry?: ModelRegistry
  readonly sessionOptions?: DefinedTeamDetachedSessionOptions
}

export interface DefinedAgentTeamOptions {
  readonly registry: ModelRegistry
  readonly members: readonly DefinedAgentTeamMemberInput[]
  readonly team?: AgentTeam | AgentTeamOptions
  readonly sessionOptions?: DefinedTeamDetachedSessionOptions
}

export declare class DefinedAgentTeam {
  readonly team: AgentTeam
  constructor(options: DefinedAgentTeamOptions)
  session(name: string): AgentSession
  run(
    name: string,
    input: AgentInput,
    invocation?: AgentInvocationOptions,
  ): Promise<AgentResponse>
  sessionNames(): readonly string[]
}

export declare function createDefinedAgentTeam(
  options: DefinedAgentTeamOptions,
): DefinedAgentTeam

type ManagedTeamDetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team' | 'tools'>

export interface ManagedAgentSpawnRequest {
  readonly name?: string
  readonly task: string
  readonly specialty?: string
}

export interface ResolvedManagedAgentSpawnRequest extends ManagedAgentSpawnRequest {
  readonly name: string
}

export interface ManagedAgentWorkerResult {
  readonly worker: string
  readonly agentId: string
  readonly conversationId: string
  readonly text: string
  readonly succeeded: boolean
}

export interface ManagedAgentWorker {
  readonly name: string
  readonly agentId: string
  readonly conversationId: string
  readonly task: string
  readonly specialty?: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly result?: ManagedAgentWorkerResult
  readonly error?: string
}

type ManagedTeamSessionOptionsWithTools = ManagedTeamDetachedSessionOptions & {
  readonly tools?: ToolCatalog | readonly ToolDefinition<any>[]
}

export interface ManagedAgentTeamOptions {
  readonly registry: ModelRegistry
  readonly lead: DefinedAgent
  readonly leadName?: string
  readonly leadDescription?: string
  readonly team?: AgentTeam | AgentTeamOptions
  readonly maxWorkers?: number
  readonly maxTaskBytes?: number
  readonly maxSpecialtyBytes?: number
  readonly workerTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly workerTemplate?: DefinedAgent
  readonly workerFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => DefinedAgent | Promise<DefinedAgent>
  readonly leadSessionOptions?: ManagedTeamSessionOptionsWithTools
  readonly workerSessionOptions?: ManagedTeamSessionOptionsWithTools
  readonly workerSessionOptionsFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => ManagedTeamSessionOptionsWithTools | Promise<ManagedTeamSessionOptionsWithTools>
  readonly onWorkerEvent?: (
    worker: string,
    event: AgentRunEvent,
  ) => void | Promise<void>
}

export declare class ManagedAgentTeam {
  readonly team: AgentTeam
  readonly lead: AgentSession
  readonly leadName: string
  constructor(options: ManagedAgentTeamOptions)
  run(input: AgentInput, invocation?: AgentInvocationOptions): Promise<AgentResponse>
  spawn(
    request: ManagedAgentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<ManagedAgentWorkerResult>
  workers(): readonly ManagedAgentWorker[]
  removeWorker(name: string): void
}

export declare function createManagedAgentTeam(
  options: ManagedAgentTeamOptions,
): ManagedAgentTeam

export interface AgentTeamMemberInput {
  readonly name: string
  readonly agent: RuntimeAgent
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
  readonly session?: RuntimeAgentSessionOptions
}

export type RuntimeAgentTeamEvent =
  | { readonly type: 'member-attached'; readonly member: string }
  | {
    readonly type: 'member-linked'
    readonly member: string
    readonly protocol: string
  }
  | { readonly type: 'message-accepted'; readonly messageId: string; readonly target: string }
  | { readonly type: 'member-run-start'; readonly member: string }
  | { readonly type: 'member-run-end'; readonly member: string }
  | { readonly type: 'member-run-error'; readonly member: string; readonly error: SupportSafeError }
  | { readonly type: 'team-closed'; readonly teamId: string }

export interface RuntimeAgentTeamOptions {
  readonly id: string
  readonly members: readonly AgentTeamMemberInput[]
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  readonly operationTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly onEvent?: (event: RuntimeAgentTeamEvent) => void
}

export interface RuntimeAgentTeam {
  readonly id: string
  readonly memberNames: readonly string[]
  /** Links a borrowed transport; unlink/close never closes the transport itself. */
  linkAgent(options: LinkAgentOptions): () => void
  sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult>
  session(name: string): RuntimeAgentSession
  run(name: string, input: string, options?: AgentRunOptions): Promise<RuntimeAgentResponse>
  close(options?: { readonly signal?: AbortSignal }): Promise<void>
}

export interface RuntimeCloseReport {
  readonly state: 'closed'
  readonly quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  readonly deadlineReached: boolean
  readonly activeRunsAtClose: number
  readonly abortedRuns: number
  readonly unsettledRuns: number
  readonly operations: readonly RuntimeOperationCloseSummary[]
  readonly components: readonly RuntimeComponentCloseReport[]
  readonly observationHealth: RuntimeObservationHealthSnapshot
}

export type RuntimeOperationKind =
  | 'agent-run'
  | 'model-catalog'
  | 'manual-compaction'
  | 'team-operation'

export interface RuntimeOperationCloseSummary {
  readonly kind: RuntimeOperationKind
  readonly activeAtClose: number
  readonly aborted: number
  readonly settled: number
  readonly unsettled: number
}

export interface RuntimeComponentCloseReport {
  readonly kind: 'provider-registration' | 'observation-exporter' | 'agent-team'
  readonly id: string
  readonly status: 'closed' | 'failed' | 'timed-out'
  readonly error?: {
    readonly code: string
    readonly stage: string
    readonly message: string
  }
}

export type RuntimeConstructionFailureReason =
  | 'invalid'
  | 'failed'
  | 'timed-out'
  | 'aborted'

export type RuntimeConstructionFailureCode =
  | 'CAPABILITY_KIND_MISMATCH'
  | 'CAPABILITY_API_UNSUPPORTED'
  | 'CAPABILITY_ID_CONFLICT'
  | 'PROVIDER_ROUTE_CONFLICT'
  | 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
  | 'OBSERVATION_BOUNDARY_UNSUPPORTED'
  | 'CAPABILITY_STARTUP_FAILED'
  | 'CAPABILITY_STARTUP_TIMEOUT'
  | 'CAPABILITY_STARTUP_ABORTED'

export interface CapabilityIdentityConflict {
  readonly namespace:
    | 'provider-plugin-id'
    | 'provider-route'
    | 'observation-exporter-id'
    | 'tool-source-id'
    | 'tool-name'
    | 'skill-provider-id'
    | 'skill-id'
    | 'team-member-name'
  readonly key: string
  readonly firstIndex: number
  readonly secondIndex: number
}

export type RuntimeConstructionComponent =
  | { readonly kind: 'provider-plugin'; readonly id: string }
  | { readonly kind: 'observation-exporter'; readonly id: string }

export declare class AgentRuntimeConstructionError extends Error {
  readonly code: 'RUNTIME_CONSTRUCTION_FAILED'
  readonly failureCode: RuntimeConstructionFailureCode
  readonly stage: 'preflight' | 'provider-setup' | 'exporter-ready' | 'activation'
  readonly reason: RuntimeConstructionFailureReason
  readonly component?: RuntimeConstructionComponent
  readonly conflict?: CapabilityIdentityConflict
  readonly cleanup: readonly RuntimeComponentCloseReport[]
}

export interface DiagnosticSnapshot {
  readonly resource: ObservationResource
  readonly events: readonly ObservationEvent[]
  readonly retainedEvents: number
  readonly retainedBytes: number
  readonly evictedEvents: number
  readonly evictedBytes: number
  readonly observationHealth: RuntimeObservationHealthSnapshot
}

export interface AgentRuntime {
  providers(): readonly RuntimeProviderInfo[]
  modelCatalog(
    route: string,
    options?: ModelCatalogOptions,
  ): Promise<RuntimeModelCatalogSnapshot>
  agent(definition: RuntimeAgentDefinitionInput): RuntimeAgent
  agent(definition: RuntimeAgentBindingInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  logger(context?: RuntimeLoggerContext): SdkLogger
  diagnostics(): DiagnosticSnapshot
  close(options?: { readonly signal?: AbortSignal }): Promise<RuntimeCloseReport>
}

export declare function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
