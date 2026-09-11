/**
 * Copilot conformance data, as one registry entry.
 *
 * Everything here is DATA and helpers over data. Nothing in this directory
 * imports `provider-copilot`, and nothing can: the testkit's only workspace
 * dependency is `core`, and inverting that to reach a provider would make the
 * package that validates providers depend on one of them. So the adapter is
 * injected by the caller, and this module supplies the frames, the endpoint pins
 * and the token-exchange responder that a Copilot run needs on top of the generic
 * conformance contract.
 *
 * The harness itself is untouched: no new check id, no new report field, no
 * `schemaVersion` bump. A Copilot pass produces exactly the report shape every
 * other provider produces, which is the property that lets the two endpoint
 * passes be compared against each other at all.
 *
 * @module ai-agent-sdk/testkit/provider/copilot
 */

import { COPILOT_GENERATION_RUNS, type CopilotGenerationRun } from './generation.ts'

export {
  COPILOT_CONFORMANCE_API_TOKEN,
  COPILOT_CONFORMANCE_GITHUB_TOKEN,
  COPILOT_TOKEN_EXCHANGE_PATH,
  withCopilotTokenExchange,
} from './exchange.ts'
export {
  COPILOT_CHAT_COMPLETIONS_FRAMES,
  COPILOT_CONFORMANCE_TEXT,
  COPILOT_RESPONSES_FRAMES,
} from './frames.ts'
export type { CopilotConformanceFrames } from './frames.ts'
export {
  COPILOT_CONFORMANCE_MODEL,
  COPILOT_GENERATION_RUNS,
} from './generation.ts'
export type { CopilotConformanceEndpoint, CopilotGenerationRun } from './generation.ts'

/**
 * The Copilot scenario groups this package ships.
 *
 * One key today. It is a record rather than a bare array because the groups that
 * follow — embedding, and the Copilot-specific endpoint/header/credential/refresh
 * groups — are separate sets with separate data, and a caller should be able to
 * ask for one by name instead of filtering a flat list.
 */
export interface CopilotConformanceRegistry {
  /** The shared generation scenario set, once per endpoint. */
  readonly generation: readonly CopilotGenerationRun[]
}

/** Copilot's entry in the testkit's provider conformance registry. */
export const COPILOT_CONFORMANCE_REGISTRY: CopilotConformanceRegistry = Object.freeze({
  generation: COPILOT_GENERATION_RUNS,
})
