/** What an adapter must implement, and what it receives. */

export { ModelAdapter, type PreparedAdapterCall } from './adapter.ts'
export {
  callConfigEquals,
  type CallConfig,
  type CallConfigAdapterDefaults,
} from './call-config.ts'
export type { GenerateOptions } from './generate-options.ts'
export type {
  ModelContext,
  ModelCatalogOptions,
  ModelCatalogSnapshot,
  ModelCatalogState,
  ModelInfo,
  ModelModality,
  ModelModalityMap,
  ModelReasoningInfo,
  ProviderInfo,
  ReasoningEffortInfo,
  ResolvedModelInfo,
} from './model-info.ts'
export {
  MAX_TIMER_DELAY_MS,
  backoffDelayMs,
  isRetryable,
  resolveRetryPolicy,
  type AlwaysRetryPolicyConfig,
  type BackoffConfig,
  type NormalRetryPolicyConfig,
  type ResolvedAlwaysRetryPolicy,
  type ResolvedNormalRetryPolicy,
  type ResolvedRetryBackoff,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from './retry-policy.ts'
export {
  isNativeToolSchema,
  type ModelToolSchema,
  type NativeImageGenerationTool,
  type NativeToolName,
  type NativeToolSchema,
  type NativeToolSchemaMap,
  type NativeWebSearchTool,
  type ToolChoice,
  type ToolSchema,
  type WebSearchLocation,
} from './tool.ts'
