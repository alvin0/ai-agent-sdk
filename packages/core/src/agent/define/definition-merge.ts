import type { AgentDefinition, AgentDefinitionInput, AgentDefinitionOverrides } from './definition.ts'
import type { AgentCompactionConfig, AgentCompactionOptions } from '../memory/compaction-config.ts'

type MergeAgentOverrides = AgentDefinitionOverrides & { readonly id?: string }

export function mergedInput(
  source: AgentDefinition,
  overrides: MergeAgentOverrides,
): AgentDefinitionInput {
  const description = mergedField('description', source, overrides)
  const toolChoice = mergedField('toolChoice', source, overrides)
  const outputFormat = mergedField('outputFormat', source, overrides)
  const skillIds = mergedField('skillIds', source, overrides)
  const maxTokens = mergedField('maxTokens', source, overrides)
  const contextWindow = mergedField('contextWindow', source, overrides)
  const inputModalities = mergedField('inputModalities', source, overrides)
  const providerOptions = mergedField('providerOptions', source, overrides)
  return {
    id: mergedField('id', source, overrides),
    name: mergedField('name', source, overrides),
    ...(description === undefined ? {} : { description }),
    provider: mergedField('provider', source, overrides),
    model: mergedField('model', source, overrides),
    ...mergedEffort(source, overrides),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    instructions: mergedField('instructions', source, overrides),
    mode: mergedField('mode', source, overrides),
    tools: mergedField('tools', source, overrides),
    nativeTools: mergedField('nativeTools', source, overrides),
    skills: mergedField('skills', source, overrides),
    ...(skillIds === undefined ? {} : { skillIds }),
    skillOptions: mergedField('skillOptions', source, overrides),
    contextSections: mergedField('contextSections', source, overrides),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    maxTurns: mergedField('maxTurns', source, overrides),
    maxToolCalls: mergedField('maxToolCalls', source, overrides),
    commentary: mergedField('commentary', source, overrides),
    memory: mergedField('memory', source, overrides),
    compaction: overrides.compaction ?? compactionInput(source.compaction),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  }
}

function compactionInput(value: AgentCompactionConfig | false): AgentCompactionOptions | false {
  if (value === false) return false
  return {
    auto: value.auto,
    ...(value.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }),
    thresholdRatio: value.thresholdRatio,
    ...(value.retainRatio === undefined ? {} : { retainRatio: value.retainRatio }),
    ...(value.retainTokens === undefined ? {} : { retainTokens: value.retainTokens }),
    ...(value.summarizationProvider === undefined ? {} : { summarizationProvider: value.summarizationProvider }),
    ...(value.summarizationModel === undefined ? {} : { summarizationModel: value.summarizationModel }),
    ...(value.summarizationEffort === undefined ? {} : { summarizationEffort: value.summarizationEffort }),
    maxSummaryTokens: value.maxSummaryTokens,
    compactionRetries: value.compactionRetries,
    maxOverflowRetries: value.maxOverflowRetries,
    maxSummaryInputChars: value.maxSummaryInputChars,
    maxSummaryRequestChars: value.maxSummaryRequestChars,
    maxSummaryRequestBytes: value.maxSummaryRequestBytes,
    maxSummaryResponseBytes: value.maxSummaryResponseBytes,
    maxSummaryStreamEvents: value.maxSummaryStreamEvents,
    summaryTimeoutMs: value.summaryTimeoutMs,
    teardownTimeoutMs: value.teardownTimeoutMs,
    maxToolResultChars: value.maxToolResultChars,
  }
}


function mergedField<Key extends keyof MergeAgentOverrides & keyof AgentDefinition>(
  key: Key, source: AgentDefinition, overrides: MergeAgentOverrides,
): NonNullable<MergeAgentOverrides[Key]> | AgentDefinition[Key] {
  return overrides[key] ?? source[key]
}

function mergedEffort(source: AgentDefinition, overrides: MergeAgentOverrides): Pick<AgentDefinitionInput, 'effort'> {
  return mergedField('effort', source, overrides) === undefined
    ? {} : { effort: mergedField('effort', source, overrides) as string }
}
