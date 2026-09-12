/**
 * The embedding extension of the provider conformance harness.
 *
 * @module ai-agent-sdk/testkit/provider/embedding
 */

export { EMBEDDING_CONFORMANCE_DEFAULTS, embeddingConformanceInputs } from './config.ts'
export { collectEmbeddingConformanceChecks, runEmbeddingConformanceSuite } from './runner.ts'
export {
  EMBEDDING_CONFORMANCE_CHECK_IDS,
  EMBEDDING_CONFORMANCE_SCENARIOS,
} from './types.ts'
export type {
  EmbeddingConformanceCase,
  EmbeddingConformanceCaseInput,
  EmbeddingConformanceCheckId,
  EmbeddingConformanceControl,
  EmbeddingConformanceControlSnapshot,
  EmbeddingConformanceDispatch,
  EmbeddingConformanceFixture,
  EmbeddingConformanceScenario,
} from './types.ts'
