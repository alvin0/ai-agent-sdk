/** Framework-independent development conformance suites. */

export {
  ProviderConformanceError,
  runProviderConformanceSuite,
} from './provider/runner.ts'
export {
  COPILOT_CHAT_COMPLETIONS_FRAMES,
  COPILOT_CONFORMANCE_API_TOKEN,
  COPILOT_CONFORMANCE_GITHUB_TOKEN,
  COPILOT_CONFORMANCE_MODEL,
  COPILOT_CONFORMANCE_REGISTRY,
  COPILOT_CONFORMANCE_TEXT,
  COPILOT_GENERATION_RUNS,
  COPILOT_RESPONSES_FRAMES,
  COPILOT_TOKEN_EXCHANGE_PATH,
  withCopilotTokenExchange,
} from './provider/copilot/index.ts'
export type {
  CopilotConformanceEndpoint,
  CopilotConformanceFrames,
  CopilotConformanceRegistry,
  CopilotGenerationRun,
} from './provider/copilot/index.ts'
export { PROVIDER_CONFORMANCE_REGISTRY } from './provider/registry.ts'
export type { ProviderConformanceRegistry } from './provider/registry.ts'
export type {
  ProviderConformanceCase,
  ProviderConformanceCaseInput,
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceControl,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderConformanceOptions,
  ProviderConformanceReport,
  ProviderConformanceScenario,
} from './provider/types.ts'
