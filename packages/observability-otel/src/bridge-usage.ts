import {
  type Attributes,
} from '@opentelemetry/api'
import {
  type ObservationEvent,
} from '@alvin0/ai-agent-sdk-core'

import { object, counter } from './bridge-values.ts'
export function reportedUsage(event: ObservationEvent): Readonly<Record<string, unknown>> | undefined {
  const direct = object(event.data.reported)
  if (direct !== undefined) return direct
  return object(object(event.data.usageReport)?.reported) ?? object(object(event.data.usage)?.reported)
}

export function estimatedUsage(event: ObservationEvent): Readonly<Record<string, unknown>> | undefined {
  return object(object(event.data.usageReport)?.estimated) ?? object(object(event.data.usage)?.estimated)
}

export function reportedUsageAttributes(event: ObservationEvent): Attributes {
  const usage = reportedUsage(event)
  if (usage === undefined) return {}
  const uncached = counter(usage.inputTokens)
  const cacheRead = counter(usage.cacheReadTokens)
  const cacheWrite = counter(usage.cacheWriteTokens)
  const output = counter(usage.outputTokens)
  const inputParts = [uncached, cacheRead, cacheWrite].filter((value): value is number => value !== undefined)
  const input = inputParts.length === 0 ? undefined : inputParts.reduce((sum, value) => sum + value, 0)
  return {
    ...input === undefined || !Number.isSafeInteger(input) ? {} : { 'gen_ai.usage.input_tokens': input },
    ...output === undefined ? {} : { 'gen_ai.usage.output_tokens': output },
    ...cacheRead === undefined ? {} : { 'gen_ai.usage.cache_read.input_tokens': cacheRead },
    ...cacheWrite === undefined ? {} : { 'gen_ai.usage.cache_write.input_tokens': cacheWrite },
    ...counter(usage.reasoningTokens) === undefined
      ? {}
      : { 'gen_ai.usage.reasoning.output_tokens': usage.reasoningTokens as number },
  }
}
