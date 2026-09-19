/** Declarative, code-first agent definitions. */

import type { ModelOutputFormat, ToolChoice, NativeToolSchema, ModelModality } from '../../contract/index.ts'
import { ReasoningEffortId, type ReasoningEffortId as ReasoningEffort } from '../../primitives/index.ts'
import type { AgentMode } from '../mode/run-agent.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { captureContextSections } from '../context/section.ts'
import type { ContextSection } from '../context/types.ts'
import {
  SKILL_TOOL_NAMES,
  resolveSkillOptions,
  validateSkillId,
  validateSkillSource,
  type AgentSkillOptions,
  type ResolvedAgentSkillOptions,
  type SkillSource,
} from '../skill/index.ts'
import {
  resolveCompactionConfig,
  type AgentCompactionConfig,
  type AgentCompactionOptions,
} from '../memory/compaction-config.ts'
import {
  resolveMemoryConfig,
  type AgentMemoryConfig,
  type AgentMemoryConfigInput,
} from '../memory/memory.ts'
import {
  AgentSession,
  type AgentResumeSessionOptions,
  type AgentSessionOptions,
} from './session.ts'
import { captureOutputFormat } from './output-format.ts'

/**
 * Fields to hand a provider's HTTP adapter for this agent's calls: extra
 * headers, or fields deep-merged into the serialized request body. The
 * caller's value always wins, even over a field the route itself set;
 * `null` in `body` deletes a field the route set.
 */
export interface AgentProviderOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
}

export interface AgentDefinitionInput {
  /** Stable code-owned identity used by traces and catalogs. */
  readonly id: string
  /** Human-readable display name; defaults to `id`. */
  readonly name?: string
  readonly description?: string
  /** Provider route; defaults to `codex`. */
  readonly provider?: string
  /** Provider model id; defaults to `gpt-5.6-luna`. */
  readonly model?: string
  /**
   * Provider reasoning effort. Omitted means no preference.
   *
   * Pure pass-through: omitted, no effort field reaches the wire request at
   * all; set, the exact string is forwarded to the provider's own effort
   * field verbatim. The SDK never validates it against a ladder or invents a
   * default — an unsupported value is the provider's rejection to make, in
   * its own error shape, not a guess this package would get stale.
   */
  readonly effort?: string
  /** Requested output budget; omission uses the selected model's declared default/cap. */
  readonly maxTokens?: number
  /** Overrides the model/route/runtime-defaults tiers, same precedence as `maxTokens`. */
  readonly contextWindow?: number
  /** Overrides the model/route/runtime-defaults tiers, same precedence as `maxTokens`. */
  readonly inputModalities?: readonly ModelModality[]
  /** The agent's stable system instructions. */
  readonly instructions: string
  /** Execution policy; defaults to `basic`. */
  readonly mode?: AgentMode
  /** Host-executed tools owned by this definition. */
  readonly tools?: readonly ToolDefinition<any>[]
  /** Provider-executed tools such as web search or image generation. */
  readonly nativeTools?: readonly NativeToolSchema[]
  /** Inline web skills and/or lazy providers such as filesystem discovery. */
  readonly skills?: readonly SkillSource[]
  /** Optional allowlist resolved across definition and per-session skill sources. */
  readonly skillIds?: readonly string[]
  /** Progressive-disclosure catalog and resource limits. */
  readonly skillOptions?: AgentSkillOptions
  /**
   * Model-visible context this agent always recomputes before a model round.
   *
   * Sections are platform-neutral callbacks. A filesystem-backed one (project
   * instruction files, working-tree state) is built by a platform package and
   * mounted here or per session.
   */
  readonly contextSections?: readonly ContextSection[]
  readonly toolChoice?: ToolChoice
  /** Constrain visible model output to plain text or a named JSON Schema. */
  readonly outputFormat?: ModelOutputFormat
  /** Maximum model iterations for one user turn; defaults to 16. */
  /** Model steps per prompt; 'auto' continues without a fixed step ceiling. */
  readonly maxTurns?: number | 'auto'
  /** Maximum host tool calls for one user turn; defaults to 64. */
  readonly maxToolCalls?: number
  /** Public progress narration policy; defaults to `concise`. */
  readonly commentary?: 'auto' | 'concise' | 'off'
  /** Durable task facts injected outside compactable conversation history. */
  readonly memory?: AgentMemoryConfigInput
  /** Automatic context checkpointing; false disables it. Defaults to enabled. */
  readonly compaction?: AgentCompactionOptions | false
  /** Extra headers/body fields for this agent's provider requests; this agent's value wins where it collides with the route's own. */
  readonly providerOptions?: AgentProviderOptions
}

export interface AgentDefinition {
  readonly id: string
  readonly name: string
  readonly description: string | undefined
  readonly provider: string
  readonly model: string
  readonly effort: ReasoningEffort | undefined
  readonly maxTokens: number | undefined
  readonly contextWindow: number | undefined
  readonly inputModalities: readonly ModelModality[] | undefined
  readonly instructions: string
  readonly mode: AgentMode
  readonly tools: readonly ToolDefinition<any>[]
  readonly nativeTools: readonly NativeToolSchema[]
  readonly skills: readonly SkillSource[]
  readonly skillIds: readonly string[] | undefined
  readonly skillOptions: ResolvedAgentSkillOptions
  readonly contextSections: readonly ContextSection[]
  readonly toolChoice: ToolChoice | undefined
  readonly outputFormat: ModelOutputFormat | undefined
  readonly maxTurns: number | 'auto'
  readonly maxToolCalls: number
  readonly commentary: 'auto' | 'concise' | 'off'
  readonly memory: AgentMemoryConfig
  readonly compaction: AgentCompactionConfig | false
  readonly providerOptions: AgentProviderOptions | undefined
}

export interface DefinedAgent extends AgentDefinition {
  /** Start an isolated, multi-turn conversation for this definition. */
  createSession(options: AgentSessionOptions): AgentSession
  /** Resume a snapshot without manually hydrating history and memory. */
  resumeSession(options: AgentResumeSessionOptions): AgentSession
  /** Derive a definition while preserving all unspecified settings. */
  with(overrides: AgentDefinitionOverrides): DefinedAgent
}

export type AgentDefinitionOverrides = Partial<Omit<AgentDefinitionInput, 'id'>>
export type CloneAgentOverrides = AgentDefinitionOverrides & { readonly id: string }
type MergeAgentOverrides = AgentDefinitionOverrides & { readonly id?: string }

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

class DefinedAgentValue implements DefinedAgent {
  readonly id: string
  readonly name: string
  readonly description: string | undefined
  readonly provider: string
  readonly model: string
  readonly effort: ReasoningEffort | undefined
  readonly maxTokens: number | undefined
  readonly contextWindow: number | undefined
  readonly inputModalities: readonly ModelModality[] | undefined
  readonly instructions: string
  readonly mode: AgentMode
  readonly tools: readonly ToolDefinition<any>[]
  readonly nativeTools: readonly NativeToolSchema[]
  readonly skills: readonly SkillSource[]
  readonly skillIds: readonly string[] | undefined
  readonly skillOptions: ResolvedAgentSkillOptions
  readonly contextSections: readonly ContextSection[]
  readonly toolChoice: ToolChoice | undefined
  readonly outputFormat: ModelOutputFormat | undefined
  readonly maxTurns: number | 'auto'
  readonly maxToolCalls: number
  readonly commentary: 'auto' | 'concise' | 'off'
  readonly memory: AgentMemoryConfig
  readonly compaction: AgentCompactionConfig | false
  readonly providerOptions: AgentProviderOptions | undefined

  constructor(input: AgentDefinitionInput) {
    validate(input)
    this.id = input.id
    this.name = input.name ?? input.id
    this.description = input.description
    this.provider = input.provider ?? 'codex'
    this.model = input.model ?? 'gpt-5.6-luna'
    this.effort = input.effort === undefined ? undefined : ReasoningEffortId(input.effort)
    this.maxTokens = input.maxTokens
    this.contextWindow = input.contextWindow
    this.inputModalities = input.inputModalities === undefined ? undefined : Object.freeze([...input.inputModalities])
    this.instructions = input.instructions
    this.mode = input.mode ?? 'basic'
    this.tools = Object.freeze([...(input.tools ?? [])])
    this.nativeTools = Object.freeze((input.nativeTools ?? []).map(tool => Object.freeze({ ...tool })))
    this.skills = Object.freeze([...(input.skills ?? [])])
    this.skillIds = input.skillIds === undefined ? undefined : Object.freeze([...input.skillIds])
    this.skillOptions = resolveSkillOptions(input.skillOptions)
    this.contextSections = captureContextSections(input.contextSections) ?? Object.freeze([])
    this.toolChoice = input.toolChoice
    this.outputFormat = captureOutputFormat(input.outputFormat)
    this.maxTurns = input.maxTurns ?? 16
    this.maxToolCalls = input.maxToolCalls ?? 64
    this.commentary = input.commentary ?? 'concise'
    this.memory = resolveMemoryConfig(input.memory)
    this.compaction = input.compaction === false ? false : resolveCompactionConfig(input.compaction)
    this.providerOptions = input.providerOptions === undefined ? undefined : Object.freeze({
      ...(input.providerOptions.headers === undefined ? {} : { headers: Object.freeze({ ...input.providerOptions.headers }) }),
      ...(input.providerOptions.body === undefined ? {} : { body: Object.freeze({ ...input.providerOptions.body }) }),
    })
    Object.freeze(this)
  }

  createSession(options: AgentSessionOptions): AgentSession {
    return new AgentSession(this, options)
  }

  resumeSession(options: AgentResumeSessionOptions): AgentSession {
    return AgentSession.fromSnapshot(this, options)
  }

  with(overrides: AgentDefinitionOverrides): DefinedAgent {
    return defineAgent(mergedInput(this, overrides))
  }
}

/** Define and validate one reusable agent. */
export function defineAgent(input: AgentDefinitionInput): DefinedAgent {
  return new DefinedAgentValue(input)
}

/** Clone an agent under a new stable id. */
export function cloneAgent(source: AgentDefinition, overrides: CloneAgentOverrides): DefinedAgent {
  return defineAgent(mergedInput(source, overrides))
}

function mergedInput(
  source: AgentDefinition,
  overrides: MergeAgentOverrides,
): AgentDefinitionInput {
  const description = overrides.description ?? source.description
  const toolChoice = overrides.toolChoice ?? source.toolChoice
  const outputFormat = overrides.outputFormat ?? source.outputFormat
  const skillIds = overrides.skillIds ?? source.skillIds
  const maxTokens = overrides.maxTokens ?? source.maxTokens
  const contextWindow = overrides.contextWindow ?? source.contextWindow
  const inputModalities = overrides.inputModalities ?? source.inputModalities
  const providerOptions = overrides.providerOptions ?? source.providerOptions
  return {
    id: overrides.id ?? source.id,
    name: overrides.name ?? source.name,
    ...(description === undefined ? {} : { description }),
    provider: overrides.provider ?? source.provider,
    model: overrides.model ?? source.model,
    ...(overrides.effort ?? source.effort) === undefined
      ? {}
      : { effort: (overrides.effort ?? source.effort) as string },
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    instructions: overrides.instructions ?? source.instructions,
    mode: overrides.mode ?? source.mode,
    tools: overrides.tools ?? source.tools,
    nativeTools: overrides.nativeTools ?? source.nativeTools,
    skills: overrides.skills ?? source.skills,
    ...(skillIds === undefined ? {} : { skillIds }),
    skillOptions: overrides.skillOptions ?? source.skillOptions,
    contextSections: overrides.contextSections ?? source.contextSections,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    maxTurns: overrides.maxTurns ?? source.maxTurns,
    maxToolCalls: overrides.maxToolCalls ?? source.maxToolCalls,
    commentary: overrides.commentary ?? source.commentary,
    memory: overrides.memory ?? source.memory,
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

function validate(input: AgentDefinitionInput): void {
  if (!ID_PATTERN.test(input.id)) {
    throw new TypeError('agent id must start with a letter and contain only letters, numbers, _ or -')
  }
  for (const [field, value] of [
    ['name', input.name], ['description', input.description], ['provider', input.provider],
    ['model', input.model], ['effort', input.effort],
  ] as const) {
    if (value !== undefined && value.trim().length === 0) {
      throw new TypeError(`agent ${field} must be a non-empty string`)
    }
  }
  if (input.instructions.trim().length === 0) {
    throw new TypeError('agent instructions must be a non-empty string')
  }
  if (input.maxTurns !== undefined && input.maxTurns !== 'auto'
    && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) {
    throw new RangeError("agent maxTurns must be a positive safe integer or 'auto'")
  }
  if (input.maxTokens !== undefined
    && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new RangeError('agent maxTokens must be a positive safe integer')
  }
  if (input.contextWindow !== undefined
    && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)) {
    throw new RangeError('agent contextWindow must be a positive safe integer')
  }
  if (input.inputModalities !== undefined
    && (input.inputModalities.length === 0
      || new Set(input.inputModalities).size !== input.inputModalities.length)) {
    throw new RangeError('agent inputModalities must be non-empty and unique')
  }
  if (input.maxToolCalls !== undefined
    && (!Number.isInteger(input.maxToolCalls) || input.maxToolCalls < 1)) {
    throw new RangeError('agent maxToolCalls must be a positive integer')
  }
  const names = new Set<string>()
  for (const tool of input.tools ?? []) {
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
      throw new TypeError('agent host tools must have a non-empty name')
    }
    if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
      throw new TypeError(`agent host tool '${tool.name}' must have a non-empty description`)
    }
    if (typeof tool.parameters !== 'object' || tool.parameters === null) {
      throw new TypeError(`agent host tool '${tool.name}' must declare JSON Schema parameters`)
    }
    if (typeof tool.execute !== 'function') {
      throw new TypeError(`agent host tool '${tool.name}' must implement execute()`)
    }
    if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)) {
      throw new RangeError(`agent host tool '${tool.name}' must have a positive timeoutMs`)
    }
    if (names.has(tool.name)) throw new TypeError(`agent has duplicate host tool '${tool.name}'`)
    names.add(tool.name)
  }
  for (const tool of input.nativeTools ?? []) {
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
      throw new TypeError('agent native tools must have a non-empty name')
    }
    if (names.has(tool.name)) throw new TypeError(`agent has duplicate tool '${tool.name}'`)
    names.add(tool.name)
  }
  if ((input.skills?.length ?? 0) > 0 || (input.skillIds?.length ?? 0) > 0) {
    for (const reserved of SKILL_TOOL_NAMES) {
      if (names.has(reserved)) throw new TypeError(`agent tool '${reserved}' collides with the skill runtime`)
    }
  }
  const directSkills = new Set<string>()
  const providers = new Set<string>()
  const allowedSkills = new Set<string>()
  for (const id of input.skillIds ?? []) {
    validateSkillId(id, 'agent skill')
    if (allowedSkills.has(id)) throw new TypeError(`agent has duplicate allowed skill '${id}'`)
    allowedSkills.add(id)
  }
  for (const source of input.skills ?? []) {
    validateSkillSource(source)
    if (source.kind === 'skill') {
      if (directSkills.has(source.id)) throw new TypeError(`agent has duplicate inline skill '${source.id}'`)
      directSkills.add(source.id)
    } else {
      if (providers.has(source.id)) throw new TypeError(`agent has duplicate skill provider '${source.id}'`)
      providers.add(source.id)
    }
  }
}
