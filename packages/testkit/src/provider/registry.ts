/**
 * Provider-specific conformance data, keyed by provider family.
 *
 * The runner in `./runner.ts` is and stays provider-agnostic: it drives whatever
 * `ProviderConformanceFixture` it is handed and knows nothing about any endpoint.
 * This registry is the other half — the DATA a particular provider needs before
 * the generic contract can be run against it, held in one place so a suite can
 * look it up by family instead of each test file carrying its own copy of a
 * provider's stream shapes.
 *
 * Adding a family here adds data only. It does not add a check id, a report field
 * or a `schemaVersion`; those belong to the runner, and a provider that needed its
 * own report shape would not be conforming to the same contract as the others.
 *
 * @module ai-agent-sdk/testkit/provider/registry
 */

import { COPILOT_CONFORMANCE_REGISTRY, type CopilotConformanceRegistry } from './copilot/index.ts'

/** Conformance data sets this package ships, by provider family. */
export interface ProviderConformanceRegistry {
  /** GitHub Copilot: one route, two wire protocols, a token exchange in front. */
  readonly copilot: CopilotConformanceRegistry
}

/** The registry itself. */
export const PROVIDER_CONFORMANCE_REGISTRY: ProviderConformanceRegistry = Object.freeze({
  copilot: COPILOT_CONFORMANCE_REGISTRY,
})
