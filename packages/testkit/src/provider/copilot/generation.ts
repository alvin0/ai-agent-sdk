/**
 * The generation scenario module for Copilot: the SAME conformance run, declared
 * twice, once per endpoint.
 *
 * The point of this module is what it does NOT contain. There is no assertion
 * here, and no second copy of the conformance contract. The existing generation
 * scenario set — inert construction, marker and route preflight, rollback, stream
 * order, usage honesty, retries, cancellation, bounded-stream failure, redaction,
 * cleanup containment, catalog states — runs unchanged; this module only supplies
 * the two things that differ between the two passes: which endpoint the router is
 * pinned to, and the frames that endpoint speaks.
 *
 * That is deliberate. Copilot's risk is not that one endpoint is broken, it is
 * that the two endpoints DIVERGE — one serializes `input`, the other `messages`;
 * one reports usage on the terminal event, the other on a trailing chunk with no
 * choices. A shared assertion set is the only way to state "both branches owe the
 * same contract" as something a run can fail.
 *
 * The endpoint is pinned with `endpointOverrides` rather than chosen by model id.
 * A conformance run must not depend on the prefix allowlist or on a catalog
 * disclosure, both of which are facts about a remote endpoint that will change;
 * an override is the one source in the router's decision order that the test
 * owns.
 *
 * @module ai-agent-sdk/testkit/provider/copilot/generation
 */

import {
  COPILOT_CHAT_COMPLETIONS_FRAMES,
  COPILOT_RESPONSES_FRAMES,
  type CopilotConformanceFrames,
} from './frames.ts'

/** The two endpoints one Copilot route dispatches to. */
export type CopilotConformanceEndpoint = 'responses' | 'chat-completions'

/** Model id both passes use, so the only difference between them is the override. */
export const COPILOT_CONFORMANCE_MODEL = 'copilot-conformance'

/** One pass of the shared generation scenario set, pinned to one endpoint. */
export interface CopilotGenerationRun {
  /** The endpoint this pass exercises. */
  readonly endpoint: CopilotConformanceEndpoint
  /** Label for the surrounding test case. */
  readonly label: string
  /** Wire model id; identical across passes. */
  readonly model: string
  /** Frames for this endpoint's stream shape. */
  readonly frames: CopilotConformanceFrames
  /**
   * The router pin, ready to spread into `CopilotProviderOptions`.
   *
   * Stated for BOTH passes, including the one that matches the router's default.
   * A pass that relied on the default would still be green if the default moved,
   * while claiming to have tested the endpoint it named.
   */
  readonly endpointOverrides: Readonly<Record<string, CopilotConformanceEndpoint>>
}

/** Declare one pass. */
function run(
  endpoint: CopilotConformanceEndpoint,
  frames: CopilotConformanceFrames,
): CopilotGenerationRun {
  return Object.freeze({
    endpoint,
    label: `Copilot generation over /${endpoint === 'responses' ? 'responses' : 'chat/completions'}`,
    model: COPILOT_CONFORMANCE_MODEL,
    frames,
    endpointOverrides: Object.freeze({ [COPILOT_CONFORMANCE_MODEL]: endpoint }),
  })
}

/**
 * Both passes, in the order a suite should run them.
 *
 * `/responses` goes first because it is the branch an override has to create:
 * `copilot-conformance` matches no responses prefix, so without the pin the
 * router would answer `/chat/completions` and the first pass would silently be a
 * duplicate of the second.
 */
export const COPILOT_GENERATION_RUNS: readonly CopilotGenerationRun[] = Object.freeze([
  run('responses', COPILOT_RESPONSES_FRAMES),
  run('chat-completions', COPILOT_CHAT_COMPLETIONS_FRAMES),
])
