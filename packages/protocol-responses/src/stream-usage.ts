import type { UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type { WireUsage } from './wire.ts'

export function mapUsage(usage: WireUsage): UsageCounters | undefined {
  const source = usage as unknown as Record<string, unknown>
  const details = recordOrUndefined(source.input_tokens_details)
  const rawInput = source.input_tokens
  const outputTokens = source.output_tokens
  const cacheRead = details?.cached_tokens
  const cacheWrite = details?.cache_write_tokens
  const reasoning = reasoningCounter(source)
  const totalTokens = source.total_tokens
  const hasAny = [rawInput, outputTokens, cacheRead, cacheWrite, reasoning, totalTokens]
    .some(value => value !== undefined)
  if (!hasAny) return undefined

  const normalized: Record<string, unknown> = {
    ...outputTokens === undefined ? {} : { outputTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
    // Omitted cache details are authoritative zero for Responses. Present
    // malformed values are retained for the accounting validator.
    ...omittedCounter(cacheRead) ? {} : { cacheReadTokens: cacheRead },
    ...omittedCounter(cacheWrite) ? {} : { cacheWriteTokens: cacheWrite },
    ...omittedCounter(reasoning) ? {} : { reasoningTokens: reasoning },
  }
  if (rawInput !== undefined) {
    normalized.inputTokens = disjointInput(rawInput, cacheRead, cacheWrite)
  }
  return normalized as UsageCounters
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function omittedCounter(value: unknown): boolean { return value === undefined || value === 0 }

function disjointInput(rawInput: unknown, cacheRead: unknown, cacheWrite: unknown): unknown {
  // Responses includes both cache buckets in input_tokens. The SDK accounts
  // for them separately; do not count cache writes twice or clamp invalid data.
  return typeof rawInput === 'number' && (cacheRead === undefined || typeof cacheRead === 'number')
    && (cacheWrite === undefined || typeof cacheWrite === 'number')
    ? rawInput - (cacheRead ?? 0) - (cacheWrite ?? 0) : rawInput
}

function reasoningCounter(source: Record<string, unknown>): unknown {
  return recordOrUndefined(source.output_tokens_details)?.reasoning_tokens
}
