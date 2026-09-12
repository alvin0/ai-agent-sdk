/**
 * `Copilot_Endpoint_Router`: decide, ONCE per model id, which endpoint a
 * generation request is dispatched to.
 *
 * ## The decision order, and what is deliberately missing from it
 *
 * ```text
 * 1. endpointOverrides[modelId]          ⇒ source 'override'
 * 2. catalog disclosure (via learn())    ⇒ source 'catalog'
 * 3. responses-model prefix allowlist    ⇒ source 'allowlist'
 * 4. /chat/completions                   ⇒ source 'default'
 * ```
 *
 * What is missing is a PROBE. Trying `/responses` to find out whether a model
 * accepts it was rejected (DD-4): a probe is a real request that spends real
 * quota and needs a real prompt, so it has an observable side effect on the
 * user's account purely to answer a metadata question. Its result is not safely
 * cacheable across accounts either, since which models an account may call
 * depends on its plan.
 *
 * ## Why the default is `/chat/completions`
 *
 * The two ways of guessing wrong are ASYMMETRIC:
 *
 * | Guessed wrong | Consequence |
 * | --- | --- |
 * | Model supports `/responses`, we sent `/chat/completions` | works, minus some Responses-specific features |
 * | Model does not support `/responses`, we sent `/responses` | HTTP 400, dead request |
 *
 * Losing a feature is recoverable at the next call; losing the call is not. So
 * the fallback leans to the endpoint every Copilot generation model answers.
 *
 * ## Why `decisions` is append-only
 *
 * Requirement 9.7 asks that the endpoint chosen for a `Logical_Call` hold for
 * that whole call, retries included. The catalog has a TTL and may refresh
 * between two retries, so a router that recomputed could answer `/responses` on
 * the first attempt and `/chat/completions` on the second — one logical call
 * split across two wire protocols, with a serialized body that no longer matches
 * the endpoint it is going to.
 *
 * This module makes that STRUCTURALLY impossible rather than conventionally
 * avoided: once a model id has a decision, no code path rewrites it.
 * {@link CopilotEndpointRouter.learn} only adds keys that have no decision yet,
 * so a later catalog refresh returning different metadata changes nothing.
 *
 * The accepted cost (DD-5): a model misclassified on the first call keeps that
 * classification for the lifetime of the adapter instance. `endpointOverrides`
 * is the instant fix, `--models` is the discovery path, and rebuilding the
 * runtime is the reset. The trade is an invariant with no exceptions instead of
 * an invariant that holds "unless the catalog refreshed".
 *
 * @module ai-agent-sdk/providers/copilot/router
 */

import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID } from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
import { OPENAI_RESPONSES_PROTOCOL_ID } from '@alvin0/ai-agent-sdk-protocol-responses'
import type { CopilotEndpoint, CopilotGenerationModel } from './catalog.ts'
import { COPILOT_ERROR_CODES } from './errors.ts'

/**
 * Re-exported from `./catalog.ts`, where the union is declared.
 *
 * The declaration lives there because this module imports
 * {@link CopilotGenerationModel} from it, so the source edge already runs
 * router → catalog and declaring the union here would make it bidirectional.
 * The re-export keeps this module the one a reader opens for endpoint selection.
 */
export type { CopilotEndpoint } from './catalog.ts'

/**
 * Model id prefixes dispatched to `/responses` when the catalog says nothing.
 *
 * Exported and overridable for the same reason `COPILOT_EDITOR_VERSION` is: this
 * is a fact about a remote endpoint that WILL go stale, and a user has to be able
 * to correct it without waiting for a release.
 * `CopilotProviderOptions.responsesModelPrefixes` ADDS to this list rather than
 * replacing it, so an override cannot silently drop the prefixes shipped here.
 *
 * Kept deliberately short. A prefix that matches too much pushes models toward
 * the endpoint where guessing wrong costs the request (see the module note), so
 * an absent prefix is the cheaper error.
 */
export const COPILOT_RESPONSES_MODEL_PREFIXES: readonly string[] = Object.freeze([
  'codex-',
  'gpt-5',
])

/** The endpoint chosen for one model id, and who chose it. */
export interface CopilotEndpointDecision {
  /** The model id the decision is keyed by, verbatim as the caller spelled it. */
  readonly model: string
  /** The endpoint the request goes to. */
  readonly endpoint: CopilotEndpoint
  /** Wire protocol id of the sub-protocol that serves {@link endpoint}. */
  readonly protocolId: string
  /**
   * Which step of the decision order produced this.
   *
   * Reported to observation (Requirement 9.8) so that when a model runs against
   * the wrong endpoint, the log says who decided rather than leaving an operator
   * to reconstruct it.
   */
  readonly source: 'override' | 'catalog' | 'allowlist' | 'default'
}

/** Memoized, append-only endpoint selection for one adapter instance. */
export interface CopilotEndpointRouter {
  /**
   * Decide the endpoint for a model id.
   *
   * MEMOIZED AND APPEND-ONLY: a key that already has a decision is returned
   * unchanged and never recomputed. This is the mechanism that makes
   * Requirement 9.7 hold — no code path can change its mind between two retries.
   * @param modelId - the wire model id of the request being dispatched.
   * @returns the decision for that model, recording it on first sight.
   */
  decide(modelId: string): CopilotEndpointDecision
  /**
   * Feed in discovered catalog metadata.
   *
   * Adds ONLY keys that have no decision yet; an id already decided is skipped
   * even when the metadata now disagrees with the recorded decision.
   * @param models - the generation half of a {@link CopilotGenerationModel} list.
   */
  learn(models: readonly CopilotGenerationModel[]): void
  /**
   * Every decision recorded so far, in the order it was recorded.
   * @returns a frozen snapshot, for `--models` and for the conformance harness.
   */
  snapshot(): readonly CopilotEndpointDecision[]
}

/** Construction options for {@link createCopilotEndpointRouter}. */
export interface CopilotEndpointRouterOptions {
  /**
   * Endpoints pinned by the application, keyed by model id. Wins over every
   * other source, including a catalog disclosure that contradicts it.
   */
  readonly overrides?: Readonly<Record<string, CopilotEndpoint>>
  /**
   * The full responses-prefix allowlist to use.
   *
   * The caller passes the already-merged list — `copilotAdapter` spreads
   * {@link COPILOT_RESPONSES_MODEL_PREFIXES} first and the user's additions
   * after — so the "adds, never replaces" rule is visible at the call site
   * instead of hidden in here. Defaults to the shipped list when omitted.
   */
  readonly prefixes?: readonly string[]
}

/** The two endpoints, so an override value can be checked against something. */
const COPILOT_ENDPOINTS: readonly CopilotEndpoint[] = Object.freeze([
  'responses',
  'chat-completions',
])

/** Protocol id per endpoint, the one place the two are tied together. */
const PROTOCOL_IDS: Readonly<Record<CopilotEndpoint, string>> = Object.freeze({
  'responses': OPENAI_RESPONSES_PROTOCOL_ID,
  'chat-completions': OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
})

/**
 * Build a router for one adapter instance.
 *
 * Overrides are validated HERE, not at dispatch: a typo in
 * `endpointOverrides` is a configuration mistake, and a configuration mistake
 * that surfaces while building the provider is cheaper than one that surfaces on
 * the first request to one particular model.
 * @param options - overrides and the merged prefix allowlist.
 * @returns a router whose `decisions` map only ever grows.
 * @throws AgentSdkError with `COPILOT_ENDPOINT_OVERRIDE_INVALID` when an
 *   override pins an endpoint that does not exist.
 */
export function createCopilotEndpointRouter(
  options: CopilotEndpointRouterOptions = {},
): CopilotEndpointRouter {
  const overrides = validateOverrides(options.overrides ?? {})
  const prefixes = normalizePrefixes(options.prefixes ?? COPILOT_RESPONSES_MODEL_PREFIXES)
  // Insertion-ordered, and only ever written through `record`.
  const decisions = new Map<string, CopilotEndpointDecision>()

  /** Write a decision for a key that has none. The single mutation point. */
  const record = (
    modelId: string,
    endpoint: CopilotEndpoint,
    source: CopilotEndpointDecision['source'],
  ): CopilotEndpointDecision => {
    const decision: CopilotEndpointDecision = Object.freeze({
      model: modelId,
      endpoint,
      protocolId: PROTOCOL_IDS[endpoint],
      source,
    })
    decisions.set(modelId, decision)
    return decision
  }

  /**
   * The decision order for a key with no recorded decision.
   *
   * `declared` is `undefined` for {@link CopilotEndpointRouter.decide}, because a
   * bare dispatch carries no catalog metadata — a disclosure only arrives through
   * {@link CopilotEndpointRouter.learn}. `undefined` is UNKNOWN, so it falls
   * through to the allowlist; `'chat-completions'` is a stated fact and stops
   * there with `source: 'catalog'`.
   */
  const resolve = (
    modelId: string,
    declared: CopilotEndpoint | undefined,
  ): CopilotEndpointDecision => {
    const override = overrides[modelId]
    if (override !== undefined) return record(modelId, override, 'override')
    if (declared !== undefined) return record(modelId, declared, 'catalog')
    if (matchesPrefix(modelId, prefixes)) return record(modelId, 'responses', 'allowlist')
    return record(modelId, 'chat-completions', 'default')
  }

  return Object.freeze({
    decide(modelId: string): CopilotEndpointDecision {
      return decisions.get(modelId) ?? resolve(modelId, undefined)
    },
    learn(models: readonly CopilotGenerationModel[]): void {
      for (const entry of models) {
        const modelId = entry.model.id
        if (decisions.has(modelId)) continue
        resolve(modelId, entry.declaredEndpoint)
      }
    },
    snapshot(): readonly CopilotEndpointDecision[] {
      return Object.freeze([...decisions.values()])
    },
  })
}

/**
 * Copy the overrides and reject any value that is not an endpoint.
 *
 * A copy rather than the caller's object, so a later mutation of what was passed
 * in cannot introduce an unvalidated endpoint after construction.
 */
function validateOverrides(
  overrides: Readonly<Record<string, CopilotEndpoint>>,
): Readonly<Record<string, CopilotEndpoint>> {
  const validated: Record<string, CopilotEndpoint> = Object.create(null)
  for (const [modelId, endpoint] of Object.entries(overrides)) {
    if (!COPILOT_ENDPOINTS.includes(endpoint)) {
      throw new AgentSdkError(
        `Copilot endpoint override for model '${modelId}' must be one of ` +
          `${COPILOT_ENDPOINTS.map((value) => `'${value}'`).join(', ')}`,
        COPILOT_ERROR_CODES.ENDPOINT_OVERRIDE_INVALID,
      )
    }
    validated[modelId] = endpoint
  }
  return Object.freeze(validated)
}

/**
 * Lower-case the prefixes and drop the ones that cannot select anything.
 *
 * An empty string is dropped rather than honoured: as a prefix it matches every
 * model id, which would route the whole catalog to `/responses` — the direction
 * where guessing wrong costs the request. Dropping it leaves the shipped
 * prefixes intact, which is what a caller adding to the list asked for.
 */
function normalizePrefixes(prefixes: readonly string[]): readonly string[] {
  const normalized: string[] = []
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string' || prefix.length === 0) continue
    const lower = prefix.toLowerCase()
    if (!normalized.includes(lower)) normalized.push(lower)
  }
  return Object.freeze(normalized)
}

/** Case-insensitive prefix match; Copilot model ids are lower-case in practice. */
function matchesPrefix(modelId: string, prefixes: readonly string[]): boolean {
  const lower = modelId.toLowerCase()
  return prefixes.some((prefix) => lower.startsWith(prefix))
}
