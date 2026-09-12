/**
 * `copilotDualProtocol`: one `RuntimeWireProtocol` that speaks two protocols,
 * choosing per model id.
 *
 * ## Why a composite protocol rather than two adapters
 *
 * `RuntimeHttpProviderOptions<Dialect>` takes exactly ONE `protocol` and one
 * `dialect`, while Requirement 9 asks for two protocols on the single `copilot`
 * route, chosen per model. Two adapters would mean two routes
 * (`ModelProviderRegistrar.registerAdapter` maps route → adapter), which is
 * precisely the configuration coupling Requirement 9 exists to remove; adding a
 * `resolveProtocol` hook to `provider-http` would change a public surface
 * (Requirement 18.4) and charge every other provider for a concept only Copilot
 * needs. So the multi-protocol concept lives HERE, behind a protocol object the
 * runtime already knows how to hold (DD-1).
 *
 * What makes it work: all three protocol methods receive a `ProtocolRequest`, and
 * `ProtocolRequest.model` is a `ResolvedModelInfo`. The routing key — `model.id` —
 * is therefore present at EVERY decision point (`endpointPath`, `serialize`,
 * `translate`), so no extra channel has to be threaded through the runtime.
 *
 * ## Two structural rules this module obeys
 *
 * 1. **No `this`.** `captureRuntimeProtocol` re-invokes each method as
 *    `Reflect.apply(method, source, args)`, so a method that read `this` would
 *    read whatever receiver the runtime happened to capture with. Every method
 *    below is a closure over `router` / `responses` / `chat`, which makes
 *    rebinding the receiver harmless.
 * 2. **The composite dialect is flat.** `defineWireProtocol` snapshots
 *    `defaultDialect` through `snapshotJsonObject` under depth/node limits, and
 *    `provider-http` merges caller overrides with a SHALLOW spread. A dialect
 *    nesting the two sub-dialects would let a caller overriding one chat flag
 *    silently drop every other chat default. {@link CopilotDialect} is primitives
 *    plus one string array — depth 2 (DD-2).
 *
 * ## The one thing the composite cannot hide
 *
 * `provider-http` sees a single protocol id, `'copilot-dual'`. The HTTP layer's
 * generic observation reports that id, not `'openai-responses'` or
 * `'openai-chat-completions'`, and `context.startProviderAttempt` takes only an
 * `origin` — which both endpoints share. So Requirement 9.8 is served by
 * {@link CopilotDualProtocolOptions.onDecision}, a channel this package owns,
 * rather than by widening a core type (DD-3).
 *
 * @module ai-agent-sdk/providers/copilot/dual-protocol
 */

import type {
  ChatCompletionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
import type { ResponsesDialect } from '@alvin0/ai-agent-sdk-protocol-responses'
import {
  defineWireProtocol,
  type ProtocolRequest,
  type ProtocolSseEvent,
  type ProtocolStreamChunk,
  type RuntimeWireProtocol,
} from '@alvin0/ai-agent-sdk-provider-http'
import type { CopilotEndpointDecision, CopilotEndpointRouter } from './router.ts'

/** Protocol id the HTTP layer reports for every Copilot request. */
export const COPILOT_DUAL_PROTOCOL_ID = 'copilot-dual'

/**
 * The Copilot dialect, FLAT on purpose.
 *
 * Declared in this module rather than in `./adapter.ts` — where the design's file
 * map lists it — for one structural reason: `copilotAdapter` builds the composite,
 * so the source edge already runs adapter → dual-protocol, and the two projection
 * functions are runtime values. Declaring them in `./adapter.ts` would make that
 * edge bidirectional, which the repo's circular-dependency check forbids. The
 * public placement is preserved by re-export: `./adapter.ts` re-exports this type
 * and both projections, the same way `./router.ts` re-exports `CopilotEndpoint`
 * from `./catalog.ts`. DD-2 also puts ownership here —
 * "the composite owns the two pure projection functions".
 *
 * Every field is a primitive or a string array. See rule 2 in the module note for
 * why nesting the two sub-dialects instead would be a silent-data-loss bug.
 */
export interface CopilotDialect {
  /** Send temperature/top_p. Both endpoints accept them; some models refuse. */
  readonly sampling: boolean
  /** Send the output-token limit. */
  readonly maxOutputTokens: boolean
  /** Send JSON-schema structured output. */
  readonly structuredOutputs: boolean
  /** Declare tools in the request. */
  readonly tools: boolean
  /** Responses only: `store`. */
  readonly store: boolean
  /** Responses only: `include`. */
  readonly include: readonly string[]
  /** Responses only: `reasoning.summary`. `'none'` asks for no summary at all. */
  readonly reasoningSummary: 'auto' | 'concise' | 'detailed' | 'none'
  /** Chat Completions only: `stream_options.include_usage`. */
  readonly streamUsage: boolean
  /** Chat Completions only: the role the system prompt travels under. */
  readonly systemRole: 'system' | 'developer'
  /** Chat Completions only: `parallel_tool_calls`. */
  readonly parallelToolCalls: boolean
  /** Prompt/session cache key, used by BOTH branches. */
  readonly promptCacheKey?: string
}

/**
 * Conservative defaults, matching each sub-protocol's own defaults where the two
 * agree.
 *
 * `store: false` because retaining prompts on someone else's server is an explicit
 * decision, `include` carries `reasoning.encrypted_content` because without it a
 * reasoning model loses its chain of thought across a tool call, and
 * `parallelToolCalls: false` because older gateways reject the field outright.
 */
export const COPILOT_DEFAULT_DIALECT: CopilotDialect = Object.freeze({
  sampling: true,
  maxOutputTokens: true,
  structuredOutputs: true,
  tools: true,
  store: false,
  include: Object.freeze(['reasoning.encrypted_content']),
  reasoningSummary: 'auto',
  streamUsage: true,
  systemRole: 'system',
  parallelToolCalls: false,
} as const satisfies CopilotDialect)

/**
 * Project the Copilot dialect onto the Responses dialect.
 *
 * PURE and TOTAL: every {@link CopilotDialect} flag has exactly one destination
 * here or none at all. `tools`, `streamUsage`, `systemRole` and
 * `parallelToolCalls` have no Responses destination and are DROPPED rather than
 * bent into a nearby flag — Responses declares tools from the request itself and
 * has no `reasoning_effort`-style neighbour worth guessing at.
 *
 * `reasoningSummary: 'none'` is expressed by ABSENCE, because that is how the
 * Responses serializer spells "ask for no summary" (`summary` is only sent when
 * the knob is defined). {@link resolvedResponsesDialect} therefore drops the
 * sub-protocol's own `reasoningSummary` default before merging, so this branch of
 * the projection is not overwritten by it.
 * @param dialect - the resolved Copilot dialect for this request.
 * @returns the Responses knobs this dialect determines, and only those.
 */
export function toResponsesDialect(dialect: CopilotDialect): Partial<ResponsesDialect> {
  return {
    sampling: dialect.sampling,
    maxOutputTokens: dialect.maxOutputTokens,
    structuredOutputs: dialect.structuredOutputs,
    store: dialect.store,
    include: [...dialect.include],
    ...(dialect.reasoningSummary === 'none' ? {} : { reasoningSummary: dialect.reasoningSummary }),
    ...(dialect.promptCacheKey === undefined ? {} : { promptCacheKey: dialect.promptCacheKey }),
  }
}

/**
 * Project the Copilot dialect onto the Chat Completions dialect.
 *
 * PURE and TOTAL, same rule as {@link toResponsesDialect}: `store`, `include` and
 * `reasoningSummary` have no Chat Completions destination and are dropped —
 * `reasoningEffort` is a different knob (how hard to think, not whether to report
 * a summary), so mapping onto it would be a guess dressed as a translation.
 *
 * Two flags change type on the way across, and each mapping is total:
 *
 * | Copilot | Chat Completions |
 * | --- | --- |
 * | `maxOutputTokens: true` | `maxTokensField: 'max_tokens'` |
 * | `maxOutputTokens: false` | `maxTokensField: false` |
 * | `structuredOutputs: true` | `structuredOutputs: 'json-schema'` |
 * | `structuredOutputs: false` | `structuredOutputs: false` |
 *
 * The accepted cost of the first row: a caller cannot reach
 * `'max_completion_tokens'` through {@link CopilotDialect}. Copilot's
 * `/chat/completions` takes `max_tokens`, and the models that demand the newer
 * spelling are the ones the router sends to `/responses` anyway, so the boolean
 * buys a flag a caller can reason about and costs a spelling no Copilot model has
 * been observed to need.
 * @param dialect - the resolved Copilot dialect for this request.
 * @returns the Chat Completions knobs this dialect determines, and only those.
 */
export function toChatCompletionsDialect(
  dialect: CopilotDialect,
): Partial<ChatCompletionsDialect> {
  return {
    sampling: dialect.sampling,
    maxTokensField: dialect.maxOutputTokens ? 'max_tokens' : false,
    structuredOutputs: dialect.structuredOutputs ? 'json-schema' : false,
    tools: dialect.tools,
    streamUsage: dialect.streamUsage,
    systemRole: dialect.systemRole,
    parallelToolCalls: dialect.parallelToolCalls,
    ...(dialect.promptCacheKey === undefined ? {} : { promptCacheKey: dialect.promptCacheKey }),
  }
}

/**
 * The parts of a sub-protocol the composite uses.
 *
 * Structural rather than an import of either package's own definition type, so
 * that a test can hand in a stub and so that neither sub-protocol's marker fields
 * become part of this contract.
 */
export interface CopilotSubProtocol<Dialect extends object> {
  /** Reported on the decision as `protocolId`. */
  readonly id: string
  /** Merged UNDER the projection by the composite; never read by the runtime. */
  readonly defaultDialect: Dialect
  readonly endpointPath: (request: ProtocolRequest, dialect: Dialect) => string
  readonly protocolHeaders?: (dialect: Dialect) => Readonly<Record<string, string>>
  readonly serialize: (
    request: ProtocolRequest,
    dialect: Dialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

/** The `/responses` half. `openAiResponsesProtocol` satisfies this. */
export type ResponsesProtocolLike = CopilotSubProtocol<ResponsesDialect>

/** The `/chat/completions` half. `openAiChatCompletionsProtocol` satisfies this. */
export type ChatCompletionsProtocolLike = CopilotSubProtocol<ChatCompletionsDialect>

/** Construction options for {@link copilotDualProtocol}. */
export interface CopilotDualProtocolOptions {
  /** Decides, once per model id, which branch a request takes. */
  readonly router: CopilotEndpointRouter
  /** The protocol serving `/responses`. */
  readonly responses: ResponsesProtocolLike
  /** The protocol serving `/chat/completions`. */
  readonly chat: ChatCompletionsProtocolLike
  /**
   * Synchronous, best-effort observer of every endpoint decision (Requirement
   * 9.8).
   *
   * Carries `{ model, endpoint, protocolId, source }` — no prompt and no
   * credential, because an observer is a diagnostic channel and neither of those
   * is diagnostic. Throwing in here does NOT affect the request: the error is
   * trapped, since a broken log sink must not decide whether a generation runs.
   */
  readonly onDecision?: (decision: CopilotEndpointDecision) => void
}

/**
 * Build the composite protocol.
 *
 * @param options - the router, the two sub-protocols, and the optional observer.
 * @returns a `RuntimeWireProtocol<CopilotDialect>` with id `'copilot-dual'`.
 */
export function copilotDualProtocol(
  options: CopilotDualProtocolOptions,
): RuntimeWireProtocol<CopilotDialect> {
  const { router, responses, chat } = options
  const onDecision = options.onDecision

  /**
   * The Responses dialect for one request.
   *
   * Merged with the SUB-PROTOCOL's defaults, not the composite's: the composite's
   * defaults are already inside `dialect` by the time the runtime calls us, and
   * what is missing is everything the Responses dialect knows about but Copilot
   * does not expose (`messagePhase`). `reasoningSummary` is dropped from the base
   * because the projection owns that key outright — see {@link toResponsesDialect}.
   */
  const resolvedResponsesDialect = (dialect: CopilotDialect): ResponsesDialect => {
    const { reasoningSummary: _ownedByProjection, ...base } = responses.defaultDialect
    return Object.freeze({ ...base, ...toResponsesDialect(dialect) })
  }

  /**
   * The Chat Completions dialect for one request.
   *
   * Same rule; the sub-protocol supplies `path`, `stop`, `seed` and
   * `reasoningEffort`, which {@link CopilotDialect} deliberately does not expose.
   */
  const resolvedChatDialect = (dialect: CopilotDialect): ChatCompletionsDialect =>
    Object.freeze({ ...chat.defaultDialect, ...toChatCompletionsDialect(dialect) })

  /** Route one request, reporting the decision on the way through. */
  const decide = (request: ProtocolRequest): CopilotEndpointDecision => {
    const decision = router.decide(request.model.id)
    report(decision)
    return decision
  }

  /** Hand the decision to the observer, swallowing whatever it does with it. */
  const report = (decision: CopilotEndpointDecision): void => {
    if (onDecision === undefined) return
    try {
      onDecision(decision)
    } catch { /* an observer must not decide whether a request runs */ }
  }

  return defineWireProtocol<CopilotDialect>({
    id: COPILOT_DUAL_PROTOCOL_ID,
    defaultDialect: COPILOT_DEFAULT_DIALECT,
    // `endpointPath` is where the decision is REPORTED, because it is the first of
    // the three methods the pipeline calls for a request, and because the router
    // is memoized and append-only: the branch reported here is the branch
    // `serialize` and `translate` will take, retries included (Requirement 9.7).
    endpointPath: (request: ProtocolRequest, dialect: CopilotDialect): string =>
      decide(request).endpoint === 'responses'
        ? responses.endpointPath(request, resolvedResponsesDialect(dialect))
        : chat.endpointPath(request, resolvedChatDialect(dialect)),
    ...protocolHeadersOf(responses, chat),
    serialize: (
      request: ProtocolRequest,
      dialect: CopilotDialect,
    ): Readonly<Record<string, unknown>> =>
      // No report here: one logical call would otherwise emit the same decision
      // two or three times, and the router's memo makes the extra reports
      // information-free.
      router.decide(request.model.id).endpoint === 'responses'
        ? responses.serialize(request, resolvedResponsesDialect(dialect))
        : chat.serialize(request, resolvedChatDialect(dialect)),
    translate: (
      events: AsyncIterable<ProtocolSseEvent>,
      request: ProtocolRequest,
      displayName: string,
    ): AsyncGenerator<ProtocolStreamChunk> =>
      router.decide(request.model.id).endpoint === 'responses'
        ? responses.translate(events, request, displayName)
        : chat.translate(events, request, displayName),
  })
}

/**
 * The composite's `protocolHeaders`, or nothing.
 *
 * This is the one method whose signature carries NO `ProtocolRequest`, so the
 * routing key that makes the other three work is absent here. Two things follow.
 * The union of both branches' headers is wrong — it would put a header belonging
 * to the branch NOT taken on the wire. And a guess is wrong for the same reason.
 * So the composite exposes a header set only when both branches produce the SAME
 * one, in which case that set is the selected branch's set whichever branch is
 * selected; when they diverge, it exposes none, and a protocol header that only
 * one branch needs has to travel through the adapter's request-scoped header path
 * where the model id is in hand.
 *
 * Today neither sub-protocol declares `protocolHeaders` — Copilot's mandatory
 * headers are endpoint identity (`editor-version`, `editor-plugin-version`), not
 * protocol facts — so this returns nothing and the branch above is the
 * forward-looking half of the rule.
 * @param responses - the `/responses` sub-protocol.
 * @param chat - the `/chat/completions` sub-protocol.
 * @returns a one-key spread carrying `protocolHeaders`, or an empty one.
 */
function protocolHeadersOf(
  responses: ResponsesProtocolLike,
  chat: ChatCompletionsProtocolLike,
): { protocolHeaders?: (dialect: CopilotDialect) => Readonly<Record<string, string>> } {
  const fromResponses = responses.protocolHeaders
  const fromChat = chat.protocolHeaders
  if (fromResponses === undefined && fromChat === undefined) return {}
  return {
    protocolHeaders: (dialect: CopilotDialect): Readonly<Record<string, string>> => {
      const left = fromResponses?.(Object.freeze({
        ...responses.defaultDialect,
        ...toResponsesDialect(dialect),
      })) ?? {}
      const right = fromChat?.(Object.freeze({
        ...chat.defaultDialect,
        ...toChatCompletionsDialect(dialect),
      })) ?? {}
      return sameHeaders(left, right) ? Object.freeze({ ...left }) : Object.freeze({})
    },
  }
}

/** Whether two header maps are equal name-for-name and value-for-value. */
function sameHeaders(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(left)
  if (names.length !== Object.keys(right).length) return false
  return names.every((name) => left[name] === right[name])
}
