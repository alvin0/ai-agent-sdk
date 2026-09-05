import { defineAgent, type DefinedAgent } from '../../agent/define/definition.ts'
import { ReasoningEffortId } from '../../primitives/brand.ts'
import { objectValue, ownData } from '../common/data.ts'
import { captureModelTarget, resolveAgentModel } from '../provider/model-selection.ts'
import type { ModelTarget, ProviderSelection } from '../provider/types.ts'
import type {
  RuntimeAgentBindingInput, RuntimeAgentDefinition, RuntimeAgentDefinitionInput,
} from './types.ts'
import { captureToolDefinitions } from '../../agent/tool/capture.ts'
import { captureToolSources } from '../tool-source/definition.ts'
import type { CapturedToolSource } from '../tool-source/types.ts'
import { captureNativeTools, captureToolChoice } from './native-tools.ts'
import { captureMemoryBinding } from '../memory/definition.ts'
import type { CapturedMemoryBinding } from '../memory/types.ts'
import { captureRuntimeSkillSources } from '../skill-provider/definition.ts'
import type { AgentCompactionConfig, AgentCompactionOptions } from '../../agent/memory/compaction-config.ts'
import { assertAgentIdentitySnapshot } from '../identity/agent.ts'

const KEYS = new Set(['id', 'name', 'description', 'model', 'instructions', 'effort', 'maxTokens', 'mode',
  'tools', 'nativeTools', 'toolChoice', 'toolSources', 'skills', 'allowedSkillIds', 'memory', 'compaction',
  'maxTurns', 'maxToolCalls', 'commentary'])

export interface BoundRuntimeAgentDefinition {
  readonly model: ModelTarget
  readonly effort?: ReturnType<typeof ReasoningEffortId>
  readonly maxTokens?: number
  readonly legacy: DefinedAgent
  readonly toolSources: readonly CapturedToolSource[]
  readonly memory?: CapturedMemoryBinding
}

/** Validate and detach one reusable runtime definition without resolving a live provider. */
export function defineRuntimeAgentDefinition(input: RuntimeAgentDefinitionInput): RuntimeAgentDefinition {
  const target = captureAuthorTarget(input)
  const selection: ProviderSelection = Object.freeze({ providers: Object.freeze([Object.freeze({
    id: 'definition-author', displayName: 'Definition author', family: 'definition-author',
    routes: Object.freeze([target.provider]), defaultModel: target,
  })]) })
  const bound = bindRuntimeAgentDefinition(input, selection)
  const legacy = bound.legacy
  return Object.freeze({ id: legacy.id, name: legacy.name,
    ...(legacy.description === undefined ? {} : { description: legacy.description }),
    model: target, instructions: legacy.instructions,
    ...(bound.effort === undefined ? {} : { effort: bound.effort }),
    ...(bound.maxTokens === undefined ? {} : { maxTokens: bound.maxTokens }),
    mode: legacy.mode, tools: legacy.tools, nativeTools: legacy.nativeTools,
    ...(legacy.toolChoice === undefined ? {} : { toolChoice: legacy.toolChoice }),
    toolSources: bound.toolSources, skills: legacy.skills,
    ...(legacy.skillIds === undefined ? {} : { allowedSkillIds: legacy.skillIds }),
    ...(bound.memory === undefined ? {} : { memory: bound.memory }),
    compaction: compactionInput(legacy.compaction), maxTurns: legacy.maxTurns,
    maxToolCalls: legacy.maxToolCalls, commentary: legacy.commentary })
}

export function cloneRuntimeAgentDefinition(
  sourceValue: RuntimeAgentDefinition,
  overridesValue: Partial<Omit<RuntimeAgentDefinitionInput, 'id'>> & { readonly id: string },
): RuntimeAgentDefinition {
  const source = objectValue(sourceValue), overrides = objectValue(overridesValue)
  if (Reflect.ownKeys(overrides).some(key => typeof key !== 'string' || !KEYS.has(key))) {
    throw new TypeError('Runtime agent overrides contain unsupported fields')
  }
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of KEYS) {
    const override = ownData(overrides, key, false)
    const value = override === undefined ? ownData(source, key, false) : override
    if (value !== undefined) merged[key] = value
  }
  if (ownData(overrides, 'id', false) === undefined) throw new TypeError('Runtime agent clone requires an id')
  return defineRuntimeAgentDefinition(merged as unknown as RuntimeAgentDefinitionInput)
}

/** Capture one runtime definition and resolve its immutable target before any model operation. */
export function bindRuntimeAgentDefinition(
  input: RuntimeAgentBindingInput,
  selection: ProviderSelection,
): BoundRuntimeAgentDefinition {
  const source = objectValue(input)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !KEYS.has(key))) {
    throw new TypeError('Runtime agent definition contains unsupported fields')
  }
  const values = Object.fromEntries([...KEYS].map(key => [key, ownData(source, key, false)])) as Record<string, unknown>
  const target = resolveAgentModel(selection, values.model)
  if (values.effort !== undefined && typeof values.effort !== 'string') throw new TypeError('Runtime agent effort must be a string')
  const effort = values.effort === undefined ? undefined : ReasoningEffortId(values.effort)
  const maxTokens = values.maxTokens as number | undefined
  const tools = values.tools === undefined ? undefined : captureToolDefinitions(values.tools)
  const toolSources = captureToolSources(values.toolSources)
  const nativeTools = captureNativeTools(values.nativeTools)
  const toolChoice = captureToolChoice(values.toolChoice)
  const memory = values.memory === undefined ? undefined : captureMemoryBinding(values.memory)
  const skills = values.skills === undefined ? undefined : captureRuntimeSkillSources(values.skills)
  assertAgentIdentitySnapshot({ ...(tools === undefined ? {} : { tools }), nativeTools,
    ...(skills === undefined ? {} : { skills }), ...(values.allowedSkillIds === undefined ? {} : {
      allowedSkillIds: values.allowedSkillIds as readonly string[],
    }) })
  const legacy = defineAgent({
    id: values.id as string,
    ...(values.name === undefined ? {} : { name: values.name as string }),
    ...(values.description === undefined ? {} : { description: values.description as string }),
    provider: target.provider, model: target.id,
    // Legacy definitions require a value; the runtime session override below preserves omission.
    effort: effort ?? 'medium',
    ...(maxTokens === undefined ? {} : { maxTokens }), instructions: values.instructions as string,
    ...(values.mode === undefined ? {} : { mode: values.mode as NonNullable<RuntimeAgentBindingInput['mode']> }),
    ...(tools === undefined ? {} : { tools }),
    ...(nativeTools.length === 0 ? {} : { nativeTools }),
    ...(skills === undefined ? {} : { skills: skills as DefinedAgent['skills'] }),
    ...(values.allowedSkillIds === undefined ? {} : { skillIds: values.allowedSkillIds as readonly string[] }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(values.compaction === undefined ? {} : { compaction: values.compaction as NonNullable<RuntimeAgentBindingInput['compaction']> }),
    ...(values.maxTurns === undefined ? {} : { maxTurns: values.maxTurns as number }),
    ...(values.maxToolCalls === undefined ? {} : { maxToolCalls: values.maxToolCalls as number }),
    ...(values.commentary === undefined ? {} : { commentary: values.commentary as NonNullable<RuntimeAgentBindingInput['commentary']> }),
  })
  return Object.freeze({ model: target, ...(effort === undefined ? {} : { effort }),
    ...(maxTokens === undefined ? {} : { maxTokens }), legacy, toolSources,
    ...(memory === undefined ? {} : { memory }) })
}

function captureAuthorTarget(input: RuntimeAgentDefinitionInput): ModelTarget {
  const source = objectValue(input)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !KEYS.has(key))) {
    throw new TypeError('Runtime agent definition contains unsupported fields')
  }
  return captureModelTarget(ownData(source, 'model'), false)
}

function compactionInput(value: AgentCompactionConfig | false): AgentCompactionOptions | false {
  if (value === false) return false
  return Object.freeze({ auto: value.auto,
    ...(value.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }),
    thresholdRatio: value.thresholdRatio,
    ...(value.retainRatio === undefined ? {} : { retainRatio: value.retainRatio }),
    ...(value.retainTokens === undefined ? {} : { retainTokens: value.retainTokens }),
    ...(value.summarizationProvider === undefined ? {} : { summarizationProvider: value.summarizationProvider }),
    ...(value.summarizationModel === undefined ? {} : { summarizationModel: value.summarizationModel }),
    ...(value.summarizationEffort === undefined ? {} : { summarizationEffort: value.summarizationEffort }),
    maxSummaryTokens: value.maxSummaryTokens, compactionRetries: value.compactionRetries,
    maxOverflowRetries: value.maxOverflowRetries, maxSummaryInputChars: value.maxSummaryInputChars,
    maxSummaryRequestChars: value.maxSummaryRequestChars, maxSummaryRequestBytes: value.maxSummaryRequestBytes,
    maxSummaryResponseBytes: value.maxSummaryResponseBytes, maxSummaryStreamEvents: value.maxSummaryStreamEvents,
    summaryTimeoutMs: value.summaryTimeoutMs, teardownTimeoutMs: value.teardownTimeoutMs,
    maxToolResultChars: value.maxToolResultChars })
}
