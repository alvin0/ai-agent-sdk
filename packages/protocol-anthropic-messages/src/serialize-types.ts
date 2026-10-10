/**
 * Adapter-private state kept on a {@link ReasoningBlock} so a thinking block can
 * be echoed back exactly.
 *
 * The signature is the load-bearing part: this API verifies it to confirm the
 * block is genuinely the model's own reasoning, and a thinking block sent back
 * without it is rejected.
 */
export interface AnthropicReasoningState {
  /** `thinking` for an ordinary block, `redacted_thinking` for an opaque one. */
  kind: 'thinking' | 'redacted_thinking'
  /** Cryptographic signature over the thinking content. */
  signature?: string
  /** Opaque payload of a redacted block. */
  data?: string
}


/** How a reasoning effort becomes a thinking token budget, for `reasoningFormat: 'thinking-budget'`. */
export type ThinkingBudgets = Readonly<Record<string, number>>

/** Which field carries reasoning effort on the wire. */
export type AnthropicReasoningFormat = 'output-config' | 'thinking-budget'

/** Options controlling how the request is built. */
export interface AnthropicSerializeOptions {
  /**
   * `'output-config'` (default, current models): effort is pass-through —
   * sent verbatim as `output_config.effort`, exactly what the caller gave.
   * `'thinking-budget'` (older models, or a gateway that only understands a
   * token budget): effort is looked up in `budgets` and converted to
   * `thinking.budget_tokens` instead — the SDK does the conversion because the
   * endpoint has no `effort` field to receive the raw string at all.
   */
  reasoningFormat?: AnthropicReasoningFormat
  /** Effort id to thinking-token budget; only consulted under `'thinking-budget'`. */
  budgets: ThinkingBudgets
  /**
   * Extended-thinking mode, sent only when set — omission means "say nothing",
   * which is this API's own way of leaving the model's default behavior alone.
   * Ignored under `'thinking-budget'`, which derives `thinking` from the effort instead.
   */
  thinking?: 'adaptive' | 'disabled'
  /**
   * Mark the stable prefix of one request as a cache breakpoint: the system
   * prompt, the last tool definition (if any), and every message but the
   * newest — up to 3 of this API's 4-breakpoint ceiling, leaving one spare.
   * A conversation resending its whole history on every turn (this API is
   * stateless) pays full price for that history without this; with it, a
   * later turn reads the unchanged prefix at a steep discount instead of
   * paying to reprocess it.
   *
   * Off by default: not every account or Anthropic-COMPATIBLE gateway
   * behind this same adapter understands `cache_control`, and a route that
   * doesn't should not silently be asked to. See `dialectOf()` in
   * `provider-anthropic/src/adapter.ts` for the live-discovered fallback
   * that turns this off automatically, permanently, the first time a
   * gateway rejects it.
   */
  promptCaching?: boolean
  /** Cache breakpoint lifetime. Defaults to this API's own default (5 minutes). */
  promptCachingTtl?: '5m' | '1h'
}

/**
 * Last-resort `max_tokens`, used only when neither the caller, the model, nor
 * the route names one. This API rejects a request that omits the field
 * entirely, unlike most others — see {@link serializeAnthropicRequest}.
 */
export const DEFAULT_MAX_TOKENS = 8_192

