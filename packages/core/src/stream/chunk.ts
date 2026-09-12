/**
 * The streaming protocol every adapter emits, and the values it carries.
 *
 * @module ai-agent-sdk/core/stream/chunk
 */

import type { ModelFailure } from '../errors/failure.ts'
import type { AssistantTextPhase, ContentBlock, ContentBlockType, ImageMediaType } from '../message/content.ts'
import type { ToolCallId } from '../primitives/brand.ts'

/**
 * Why a model response stopped. Merge-extensible, so an adapter can surface a
 * provider-specific reason without a core release.
 *
 * `aborted` and `error` carry their failure inline because a stream that fails
 * still has to END — a thrown exception mid-iteration would strand whatever text
 * had already been assembled.
 */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: ModelFailure }
  'error': { kind: 'error'; failure: ModelFailure }
}

/** Any known finish reason. Switch on `kind` and fall through unknowns. */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/**
 * Token accounting for one model call.
 *
 * Counts are DISJOINT, which is the one thing to get right here: `inputTokens` is
 * UNCACHED input only, and cached input is reported separately, so billed input is
 * the sum of the three. Providers disagree — some fold cache hits into a single
 * prompt total — and the adapter subtracts them back out to honour this
 * convention. Without it, every cost calculation double-counts cache hits.
 */
export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number
  outputTokens: number
  /**
   * Exact full-call total.
   *
   * Set only when authoritative: preserved from a provider total, or derived from
   * aggregate counters that agree. Omitted rather than guessed.
   */
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Adapter-private lossless-JSON state for replaying a successful response.
 *
 * Carried by the terminal `finish` chunk and stored on the assembled message.
 * Both halves stay opaque above the adapter; only the SPLIT is shared vocabulary,
 * which is what lets assembly keep stored metadata aligned with stored content
 * without understanding either half.
 */
export interface ReplayEnvelope {
  /** Response-level adapter-private metadata (ids, native stop reason). */
  response: unknown
  /**
   * Per-block adapter-private metadata, one entry per emitted block in first-seen
   * stream order.
   *
   * When assembly drops a block it drops the entry at the same position. An
   * envelope whose length does not match the emitted block count is discarded
   * whole, because a misaligned mapping is worse than none. An adapter whose
   * metadata is independent of block structure omits this field.
   */
  blocks?: readonly unknown[]
}

/**
 * The raw streaming protocol every adapter emits.
 *
 * Contract adapters must honour:
 * - `index` correlates the deltas of interleaved blocks. It is adapter-assigned in
 *   first-seen order and need not match any provider's own numbering.
 * - `block-end` carries the AUTHORITATIVE assembled block, so a consumer that
 *   trusts it never has to re-derive one from deltas.
 * - `usage` precedes the terminal `finish`, and NOTHING follows `finish`.
 * - tool arguments stay raw JSON strings.
 *
 * An adapter may throw, but the registry normalizes that into a terminal `error`
 * or `aborted` finish before a consumer ever sees it.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string; phase?: AssistantTextPhase }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
    type: 'image-delta'
    index: number
    itemId: string
    data: string
    mediaType: ImageMediaType
    partialIndex?: number
  }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  /** Cumulative snapshot for this attempt, never an additive or final report. */
  | { type: 'usage-progress'; usage: Partial<TokenUsage>; attemptId?: string }
  | {
    type: 'finish'
    reason: FinishReason
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope
  }
