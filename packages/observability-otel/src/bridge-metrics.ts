import {
  type Attributes,
  type Counter,
  type Meter,
} from '@opentelemetry/api'
import {
  type ObservationEvent,
} from '@alvin0/ai-agent-sdk-core'
import {
  projectMetrics,
} from '@alvin0/ai-agent-sdk-core/observability'

import type { MetricSinks } from './bridge-types.ts'
import { object, string, counter, finite } from './bridge-values.ts'
import { reportedUsage, estimatedUsage } from './bridge-usage.ts'
export function metricAttributes(event: ObservationEvent): Attributes {
  const error = object(event.data.error)
  return {
    ...string(event.data.provider) === undefined ? {} : { 'gen_ai.provider.name': event.data.provider as string },
    ...string(event.data.operation) === undefined ? {} : { 'ai_agent_sdk.operation': event.data.operation as string },
    ...string(event.data.status) === undefined ? {} : { 'ai_agent_sdk.status': event.data.status as string },
    ...string(error?.code) === undefined ? {} : { 'error.type': error?.code as string },
  }
}

export function recordInternalUsage(sinks: MetricSinks, event: ObservationEvent): void {
  if (event.phase !== 'end') return
  const reported = reportedUsage(event)
  const estimated = estimatedUsage(event)
  const base = metricAttributes(event)
  if (event.name === 'sdk.model.call') {
    recordCounterSet(sinks.sdkTokenUsage, reported, 'reported', base)
    recordCounterSet(sinks.sdkTokenUsage, estimated, 'estimated', base)
    const coverage = string(event.data.coverage) ?? string(object(event.data.usageReport)?.coverage)
    if (coverage !== undefined) sinks.sdkUsageCoverage.add(1, { ...base, 'ai_agent_sdk.usage.coverage': coverage })
    recordSemanticUsage(sinks, reported, base)
  } else if (event.name === 'sdk.agent.run') {
    recordCounterSet(sinks.sdkTokenUsage, estimated, 'estimated', base)
    recordRunCoverage(sinks, event, base)
  }
}

export function recordCounterSet(
  instrument: Counter,
  values: Readonly<Record<string, unknown>> | undefined,
  source: 'reported' | 'estimated',
  base: Attributes,
): void {
  if (values === undefined) return
  for (const [key, tokenType] of [
    ['inputTokens', 'input'],
    ['outputTokens', 'output'],
    ['cacheReadTokens', 'cache-read'],
    ['cacheWriteTokens', 'cache-write'],
    ['reasoningTokens', 'reasoning'],
  ] as const) {
    const value = counter(values[key])
    if (value !== undefined) instrument.add(value, {
      ...base,
      'ai_agent_sdk.token.type': tokenType,
      'ai_agent_sdk.usage.source': source,
    })
  }
}

export function recordSemanticUsage(
  sinks: MetricSinks,
  values: Readonly<Record<string, unknown>> | undefined,
  base: Attributes,
): void {
  if (values === undefined) return
  const uncached = counter(values.inputTokens)
  const cacheRead = counter(values.cacheReadTokens) ?? 0
  const cacheWrite = counter(values.cacheWriteTokens) ?? 0
  const output = counter(values.outputTokens)
  const hasInput = uncached !== undefined
    || counter(values.cacheReadTokens) !== undefined
    || counter(values.cacheWriteTokens) !== undefined
  if (hasInput) {
    const input = (uncached ?? 0) + cacheRead + cacheWrite
    if (Number.isSafeInteger(input)) sinks.genAiTokenUsage.record(input, {
      ...base,
      'gen_ai.operation.name': 'chat',
      'gen_ai.token.type': 'input',
      'ai_agent_sdk.usage.source': 'reported',
    })
  }
  if (output !== undefined) sinks.genAiTokenUsage.record(output, {
    ...base,
    'gen_ai.operation.name': 'chat',
    'gen_ai.token.type': 'output',
    'ai_agent_sdk.usage.source': 'reported',
  })
}

export function recordMetrics(sinks: MetricSinks, event: ObservationEvent): void {
  const base = metricAttributes(event)
  for (const projection of projectMetrics(event)) {
    const attributes = { ...base, ...projection.attributes } as Attributes
    switch (projection.name) {
      case 'ai_agent_sdk.model.call.duration':
        sinks.sdkModelDuration.record(projection.value, attributes)
        sinks.genAiClientDuration.record(projection.value / 1_000, {
          ...base, 'gen_ai.operation.name': 'chat',
        })
        break
      case 'ai_agent_sdk.provider.attempt.duration':
        sinks.sdkProviderDuration.record(projection.value, attributes); break
      case 'ai_agent_sdk.tool.call.duration':
        sinks.sdkToolDuration.record(projection.value, attributes)
        sinks.genAiToolDuration.record(projection.value / 1_000, {
          ...base, 'gen_ai.operation.name': 'execute_tool',
        })
        break
      case 'ai_agent_sdk.provider.retry': sinks.sdkProviderRetry.add(projection.value, attributes); break
      // Usage is mapped from the canonical reported/estimated shapes below so
      // model, attempt, and run aggregates cannot double count one call.
      case 'ai_agent_sdk.token.usage':
      case 'ai_agent_sdk.usage.coverage': break
    }
  }
  recordAgentDuration(sinks, event, base)
  recordInternalUsage(sinks, event)
}

export function createMetricSinks(meter: Meter): MetricSinks {
  return {
    sdkModelDuration: meter.createHistogram('ai_agent_sdk.model.call.duration', { unit: 'ms' }),
    sdkProviderDuration: meter.createHistogram('ai_agent_sdk.provider.attempt.duration', { unit: 'ms' }),
    sdkToolDuration: meter.createHistogram('ai_agent_sdk.tool.call.duration', { unit: 'ms' }),
    sdkTokenUsage: meter.createCounter('ai_agent_sdk.token.usage', { unit: '{token}' }),
    sdkUsageCoverage: meter.createCounter('ai_agent_sdk.usage.coverage', { unit: '{call}' }),
    sdkProviderRetry: meter.createCounter('ai_agent_sdk.provider.retry', { unit: '{retry}' }),
    genAiClientDuration: meter.createHistogram('gen_ai.client.operation.duration', { unit: 's' }),
    genAiTokenUsage: meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}' }),
    genAiAgentDuration: meter.createHistogram('gen_ai.invoke_agent.duration', { unit: 's' }),
    genAiToolDuration: meter.createHistogram('gen_ai.execute_tool.duration', { unit: 's' }),
  }
}

function recordRunCoverage(sinks: MetricSinks, event: ObservationEvent, base: Attributes) {
    const coverage = object(object(event.data.usage)?.coverage)
    for (const state of ['complete', 'partial', 'estimated', 'missing', 'notApplicable'] as const) {
      const value = counter(coverage?.[state])
      if (value !== undefined && value > 0) sinks.sdkUsageCoverage.add(value, {
        ...base,
        'ai_agent_sdk.usage.coverage': state === 'notApplicable' ? 'not-applicable' : state,
      })
    }
}

function recordAgentDuration(sinks: MetricSinks, event: ObservationEvent, base: Attributes) {
  if (event.name === 'sdk.agent.run' && event.phase === 'end') {
    const duration = finite(event.data.durationMs)
    if (duration !== undefined) sinks.genAiAgentDuration.record(duration / 1_000, {
      ...base, 'gen_ai.operation.name': 'invoke_agent',
    })
  }
}
