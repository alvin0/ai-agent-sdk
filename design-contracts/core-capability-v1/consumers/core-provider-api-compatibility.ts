import {
  APP_IDENTITY,
  AgentSdkError,
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  MAX_TIMER_DELAY_MS,
  MISSING_CREDENTIAL_CODE,
  MODEL_ERROR_CODES,
  ModelAdapter,
  ModelCallObservationError,
  ModelError,
  ModelRegistry,
  OBSERVATION_ERROR_CODES,
  PluginError,
  QUOTA_EXCEEDED_CODE,
  REGISTRY_ERROR_CODES,
  SDK_VERSION,
  addUsageCounters,
  assertNever,
  assertUsableApiKey,
  attributionHeaders,
  backoffDelayMs,
  callConfigEquals,
  classifyUsageCoverage,
  contentHasImage,
  deepFreeze,
  detachedFrozen,
  errorChain,
  hasUsageCounters,
  isAgentSdkError,
  isContextWindowExceededError,
  isJsonValue,
  isQuotaExceededError,
  isRetryable,
  normalizeApiKey,
  possiblyBilledAttemptsWithoutUsage,
  projectImagesForTextModel,
  resolveRetryPolicy,
  textOnlyImageText,
  userAgent,
  validateUsageCounters,
  waitForSettlement,
  withIdleTimeout,
  withRetry,
  type ApiKeyCheck,
  type ApiKeyRejection,
  type AppIdentity,
  type AttemptUsageReport,
  type CallConfig,
  type CallConfigAdapterDefaults,
  type GenerateOptions,
  type EndProviderAttemptInput,
  type Message,
  type ModelCallHandle,
  type ModelCallReport,
  type ModelContext,
  type ModelErrorOptions,
  type ModelInfo,
  type ModelInvocationContext,
  type ModelModality,
  type ModelModalityMap,
  type ModelProviderPlugin,
  type ModelProviderRegistrar,
  type ModelReasoningInfo,
  type ModelRegistryOptions,
  type PluginRegistrationHandle,
  type PreparedCall,
  type ProviderRetryScheduledInput,
  type ReasoningEffortInfo,
  type ResolvedAlwaysRetryPolicy,
  type ResolvedModelInfo,
  type ResolvedNormalRetryPolicy,
  type ResolvedRetryBackoff,
  type ResolvedRetryPolicy,
  type RetryAttempt,
  type StreamChunk,
  type UsageAdditionResult,
  type UsageCounters,
  type UsageCoverage,
  type UsageValidationResult,
  type WithRetryOptions,
} from '@ai-agent-sdk/core'

type Equivalent<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left] ? true : false
    : false
type Assert<Value extends true> = Value

export type CoreProviderApiShape = [
  Assert<Equivalent<ApiKeyRejection, 'empty' | 'illegalCharacters'>>,
  Assert<Equivalent<ModelModality, ModelModalityMap[keyof ModelModalityMap]>>,
  Assert<Equivalent<ModelContext, { contextWindow: number }>>,
  Assert<Equivalent<ResolvedAlwaysRetryPolicy['mode'], 'always'>>,
  Assert<Equivalent<ResolvedNormalRetryPolicy['mode'], 'normal'>>,
  Assert<Equivalent<keyof ResolvedRetryBackoff,
    'initialDelayMs' | 'maxDelayMs' | 'jitterRatio'>>,
]

export type CoreProviderTypeInventory = [
  ApiKeyCheck,
  AppIdentity,
  AttemptUsageReport,
  CallConfig,
  CallConfigAdapterDefaults,
  EndProviderAttemptInput,
  Message,
  ModelCallHandle,
  ModelCallReport,
  ModelErrorOptions,
  ModelInfo,
  ModelInvocationContext,
  ModelProviderPlugin,
  ModelProviderRegistrar,
  ModelReasoningInfo,
  ModelRegistryOptions,
  PluginRegistrationHandle,
  PreparedCall,
  ProviderRetryScheduledInput,
  ReasoningEffortInfo,
  ResolvedModelInfo,
  ResolvedRetryPolicy,
  RetryAttempt,
  UsageAdditionResult,
  UsageCounters,
  UsageCoverage,
  UsageValidationResult,
  WithRetryOptions,
]

export type CoreProviderValueInventory = [
  typeof APP_IDENTITY,
  typeof AgentSdkError,
  typeof BlockAssembler,
  typeof CONTEXT_WINDOW_EXCEEDED_CODE,
  typeof EMPTY_RESPONSE_CODE,
  typeof INVALID_CREDENTIAL_CODE,
  typeof MAX_TIMER_DELAY_MS,
  typeof MISSING_CREDENTIAL_CODE,
  typeof MODEL_ERROR_CODES,
  typeof ModelCallObservationError,
  typeof ModelError,
  typeof ModelRegistry,
  typeof OBSERVATION_ERROR_CODES,
  typeof PluginError,
  typeof QUOTA_EXCEEDED_CODE,
  typeof REGISTRY_ERROR_CODES,
  typeof SDK_VERSION,
]

class CompatibilityAdapter extends ModelAdapter {
  async *stream(
    options: GenerateOptions,
    _context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const legacyAdvancedPlugin: ModelProviderPlugin = {
  id: 'compatibility-provider',
  displayName: 'Compatibility provider',
  setup(registrar) {
    return registrar.registerAdapter(['compatibility-provider'], new CompatibilityAdapter())
  },
}

async function* values(): AsyncIterable<number> { yield 1 }

/** Representative source that must compile unchanged before and after the core move. */
export async function exerciseCoreProviderApi(signal: AbortSignal): Promise<void> {
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 2 }, 'retry')
  const delay = backoffDelayMs(policy, 1, () => 0.5)
  void isRetryable(policy, MODEL_ERROR_CODES.SERVER, 0)
  void MAX_TIMER_DELAY_MS
  const config: CallConfig = { provider: 'compatibility-provider', model: 'model' }
  void callConfigEquals(config, { ...config })

  const registry = new ModelRegistry({ maxCatalogModels: 16, maxCatalogBytes: 1024 })
  const installed = registry.install(legacyAdvancedPlugin)
  const prepared = await registry.prepareCall(config, signal)
  const handle: ModelCallHandle = prepared.stream({
    ...config,
    messages: [],
    signal,
  })
  void handle.report
  installed()

  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } })
  void assembler.blocks()
  void assembler.interruptedBlocks()
  void assembler.finish
  void assembler.replayState
  void assembler.usage

  const validation = validateUsageCounters({ inputTokens: 1, outputTokens: 1 })
  const addition = addUsageCounters([validation.reported])
  void hasUsageCounters(addition.counters)
  void classifyUsageCoverage([], addition.counters)
  void possiblyBilledAttemptsWithoutUsage([])

  const checked: ApiKeyCheck = normalizeApiKey(' key ')
  if (checked.ok) void assertUsableApiKey(checked.value, 'fixture', 'FIXTURE_KEY')
  void attributionHeaders(APP_IDENTITY)
  void userAgent(APP_IDENTITY)
  void isJsonValue({ delay })
  void contentHasImage([])
  void projectImagesForTextModel([])
  void textOnlyImageText({ type: 'image', source: { kind: 'url', url: 'https://example.test' } })

  const error = new ModelError('failed', MODEL_ERROR_CODES.UNKNOWN)
  void isAgentSdkError(error)
  void isContextWindowExceededError(error.message)
  void isQuotaExceededError(error.message)
  void errorChain(error)
  void deepFreeze({ policy })
  void detachedFrozen({ policy })
  void withRetry(new CompatibilityAdapter(), { policy })
  for await (const value of withIdleTimeout(values(), 1000, () => error)) void value
  void await waitForSettlement(Promise.resolve(), 1000)
}

export function unreachable(value: never): never {
  return assertNever(value, 'core-provider-api-compatibility')
}
