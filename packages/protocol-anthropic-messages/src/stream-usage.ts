import { MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import type { FinishReason, UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type { WireStopReason, WireUsage } from './wire.ts'

export interface UsageAccumulator {
  input: unknown
  output: unknown
  cacheRead: unknown
  cacheWrite: unknown
  seen: boolean
}

export function absorbUsage(target: UsageAccumulator, usage: WireUsage | undefined): void {
  if (typeof usage !== 'object' || usage === null) return
  if ('input_tokens' in usage) target.input = usage.input_tokens
  if ('output_tokens' in usage) target.output = usage.output_tokens
  if ('cache_read_input_tokens' in usage && usage.cache_read_input_tokens !== null) {
    target.cacheRead = usage.cache_read_input_tokens
  }
  if ('cache_creation_input_tokens' in usage && usage.cache_creation_input_tokens !== null) {
    target.cacheWrite = usage.cache_creation_input_tokens
  }
  target.seen = true
}

export function finalUsage(accumulated: UsageAccumulator): UsageCounters | undefined {
  if (!accumulated.seen) return undefined
  const output: Record<string, unknown> = {
    ...accumulated.input === undefined ? {} : { inputTokens: accumulated.input },
    ...accumulated.output === undefined ? {} : { outputTokens: accumulated.output },
    // Cache omission/null is authoritative zero for this protocol. Invalid
    // present values are retained so the accounting boundary can record them.
    ...omittedCacheCounter(accumulated.cacheRead)
      ? {} : { cacheReadTokens: accumulated.cacheRead },
    ...omittedCacheCounter(accumulated.cacheWrite)
      ? {} : { cacheWriteTokens: accumulated.cacheWrite },
  }
  const counters = [
    accumulated.input,
    accumulated.cacheRead ?? 0,
    accumulated.cacheWrite ?? 0,
    accumulated.output,
  ]
  if (counters.every(validUsageCounter)) {
    output.totalTokens = counters.reduce<number>((total, value) => total + value, 0)
  }
  return output as UsageCounters
}

export function validUsageCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function finishReason(stop: WireStopReason | null | undefined): FinishReason {
  switch (stop) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'refusal':
      return {
        kind: 'error',
        failure: {
          message: 'the model refused to answer',
          code: MODEL_ERROR_CODES.INVALID_REQUEST,
        },
      }
    // `end_turn`, `stop_sequence`, and `pause_turn` all mean the turn produced a
    // complete answer as far as a caller is concerned.
    default: return { kind: 'stop' }
  }
}

function omittedCacheCounter(value: unknown): boolean { return value === undefined || value === 0 }
