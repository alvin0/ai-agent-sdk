import { MODEL_ERROR_CODES, ModelError, ToolCallId  } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, FinishReason, UsageCounters  } from '@alvin0/ai-agent-sdk-core'
import type {
  WireErrorBody,
  WireFinishReason,
  WireToolCallDelta,
  WireUsage,
} from './wire.ts'

/** The `data:` payload that ends the body; not a finish, and not a chunk. */

/** Substituted when a zero-parameter tool sends no `arguments` at all. */
const EMPTY_ARGUMENTS = '{}'

/** One in-flight tool call, correlated by the wire's `index`. */
export interface OpenToolCall {
  /** Our own block index, assigned in first-seen order at emit time. */
  readonly order: number
  id: string | undefined
  name: string | undefined
  /** Fragments joined verbatim. Never parsed until the terminal finish. */
  args: string
}

/** One in-flight text or reasoning block. */
export interface OpenTextBlock {
  readonly index: number
  text: string
}

export function malformed(displayName: string, detail: string, cause?: unknown): ModelError {
  return new ModelError(
    `${displayName} sent a malformed stream event: ${detail}`,
    MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    cause === undefined ? {} : { cause },
  )
}

export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Normalize usage, honouring the SDK's disjoint-count convention.
 *
 * This API reports `prompt_tokens` as the TOTAL input and
 * `prompt_tokens_details.cached_tokens` as a SUBSET of it, while the SDK's three
 * input figures are disjoint and sum to what is billed. So the cached portion is
 * subtracted back out here; skip that and every cost estimate double-counts
 * cache hits.
 *
 * Otherwise the counters travel RAW: malformed values are passed through rather
 * than dropped, and nothing here decides whether the report is complete. That
 * judgement belongs to the accounting boundary above, which is the only layer
 * that knows what the caller asked for.
 */
export function mapUsage(usage: WireUsage): UsageCounters | undefined {
  const source = usage as unknown as Record<string, unknown>
  const promptDetails = recordOrUndefined(source.prompt_tokens_details)
  const completionDetails = recordOrUndefined(source.completion_tokens_details)
  const promptTokens = source.prompt_tokens
  const outputTokens = source.completion_tokens
  const totalTokens = source.total_tokens
  const cacheRead = promptDetails?.cached_tokens
  const reasoning = completionDetails?.reasoning_tokens

  const present = [promptTokens, outputTokens, totalTokens, cacheRead, reasoning]
    .some(value => value !== undefined)
  if (!present) return undefined

  const counters: Record<string, unknown> = {
    ...outputTokens === undefined ? {} : { outputTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
    // An omitted or zero cache figure is authoritative zero for this API; a
    // present-but-invalid one is retained for the accounting validator.
    ...usageSubsets(cacheRead, reasoning),
  }
  if (promptTokens !== undefined) {
    counters.inputTokens = uncachedInput(promptTokens, cacheRead)
  }
  return counters as UsageCounters
}

/**
 * Map this API's finish reason onto ours.
 *
 * `content_filter` becomes a terminal `error` finish rather than a thrown
 * exception, so whatever text arrived before the filter tripped still reaches
 * the caller. `function_call` is the pre-`tools` spelling of `tool_calls` and
 * means the same thing.
 */
export function finishReasonOf(reason: WireFinishReason): FinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return {
        kind: 'error',
        failure: {
          message: 'the endpoint filtered this response',
          code: MODEL_ERROR_CODES.INVALID_REQUEST,
        },
      }
    default:
      return { kind: 'stop' }
  }
}

/** Whether this finish reason is the one that releases accumulated tool calls. */
export function releasesToolCalls(reason: WireFinishReason): boolean {
  return reason === 'tool_calls' || reason === 'function_call'
}

/** Turn an inline stream error into a typed failure. */
export function inlineError(error: WireErrorBody, displayName: string): ModelError {
  const message = error.message ?? `${displayName} reported an error mid-stream`
  const code = error.code ?? error.type
  // An unrecognized inline error defaults to SERVER, which IS retryable: the
  // turn produced nothing usable, so repeating it is safe and often works.
  return new ModelError(
    code === undefined ? message : `${message} (${String(code)})`,
    MODEL_ERROR_CODES.SERVER,
  )
}

/** Fold one tool-call fragment into the accumulator. */
export function absorbToolCall(
  open: Map<number, OpenToolCall>,
  fragment: WireToolCallDelta,
  nextOrder: () => number,
): void {
  const key = typeof fragment.index === 'number' ? fragment.index : 0
  let entry = open.get(key)
  if (entry === undefined) {
    entry = { order: nextOrder(), id: undefined, name: undefined, args: '' }
    open.set(key, entry)
  }
  // `id` and `name` arrive once. A later fragment repeating them is harmless;
  // a later fragment CLEARING them would not be, so only truthy values land.
  if (typeof fragment.id === 'string' && fragment.id.length > 0) entry.id = fragment.id
  const name = fragment.function?.name
  if (typeof name === 'string' && name.length > 0) entry.name = name
  const args = fragment.function?.arguments
  // Concatenation only. The joined string is the model's own bytes, replayed
  // verbatim on the next turn, so no reformatting happens anywhere on this path.
  if (typeof args === 'string') entry.args += args
}

/**
 * Build the authoritative tool-call blocks, parsing `arguments` right here.
 *
 * This is the single moment the accumulated string is allowed to be parsed, and
 * a failure is a protocol error. The alternative — emitting the call with empty
 * arguments — would hand the agent loop a call the model never made.
 */
export function toolCallBlocks(
  open: Map<number, OpenToolCall>,
  displayName: string,
): {
  index: number
  id: string
  name: string
  arguments: string
  block: ContentBlock
}[] {
  return [...open.entries()]
    .sort(([left], [right]) => left - right)
    .map(([wireIndex, entry]) => {
      if (entry.id === undefined || entry.name === undefined) {
        throw malformed(
          displayName,
          `tool call at index ${wireIndex} never carried an id and a name`,
        )
      }
      const args = entry.args.length > 0 ? entry.args : EMPTY_ARGUMENTS
      try {
        JSON.parse(args)
      } catch (error: unknown) {
        throw malformed(
          displayName,
          `tool call "${entry.name}" produced arguments that are not valid JSON`,
          error,
        )
      }
      return {
        index: entry.order,
        id: entry.id,
        name: entry.name,
        arguments: args,
        block: {
          type: 'tool-call',
          id: ToolCallId(entry.id),
          name: entry.name,
          arguments: args,
        } satisfies ContentBlock,
      }
    })
}


function uncachedInput(promptTokens: unknown, cacheRead: unknown): unknown {
  return typeof promptTokens === 'number' && (cacheRead === undefined || typeof cacheRead === 'number')
    ? promptTokens - (cacheRead ?? 0) : promptTokens
}

function usageSubsets(cacheRead: unknown, reasoning: unknown) {
  return {
    ...cacheRead === undefined || cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}
