/** Declarative, code-first agent definitions. */

import type { ModelOutputFormat, ToolChoice, NativeToolSchema, ModelModality } from '../../contract/index.ts'
import { ReasoningEffortId, type ReasoningEffortId as ReasoningEffort } from '../../primitives/index.ts'
import type { AgentMode } from '../mode/run-agent.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { captureContextSections } from '../context/section.ts'
import type { ContextSection } from '../context/types.ts'
import {
  resolveSkillOptions,
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
import { mergedInput } from './definition-merge.ts'
import { validateDefinition } from './definition-validation.ts'
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
  /** Public progress narration policy; defaults to `auto` (caller-defined style). */
  readonly commentary?: 'auto' | 'concise' | 'off'
  /** Durable task facts injected outside compactable conversation history. */
  readonly memory?: AgentMemoryConfigInput
  /** Automatic context checkpointing; false disables it. Defaults to enabled. */
  readonly compaction?: AgentCompactionOptions | false
  /** Extra headers/body fields for this agent's provider requests;
   * this agent's value wins where it collides with the route's own. */
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
    validateDefinition(input)
    this.id = input.id
    this.name = input.name ?? input.id
    this.description = input.description
    this.provider = input.provider ?? 'codex'
    this.model = input.model ?? 'gpt-5.6-luna'
    this.effort = input.effort === undefined ? undefined : ReasoningEffortId(input.effort)
    this.maxTokens = input.maxTokens
    this.contextWindow = input.contextWindow
    this.inputModalities = optionalFrozenList(() => input.inputModalities)
    this.instructions = input.instructions
    this.mode = input.mode ?? 'basic'
    this.tools = frozenList(input.tools)
    this.nativeTools = captureNativeTools(input.nativeTools)
    this.skills = frozenList(input.skills)
    this.skillIds = optionalFrozenList(() => input.skillIds)
    this.skillOptions = resolveSkillOptions(input.skillOptions)
    this.contextSections = captureContextSections(input.contextSections) ?? Object.freeze([])
    this.toolChoice = input.toolChoice
    this.outputFormat = captureOutputFormat(input.outputFormat)
    this.maxTurns = input.maxTurns ?? 16
    this.maxToolCalls = input.maxToolCalls ?? 64
    this.commentary = input.commentary ?? 'auto'
    this.memory = resolveMemoryConfig(input.memory)
    this.compaction = captureCompaction(input)
    this.providerOptions = captureProviderOptions(input)
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

function frozenList<Value>(input: readonly Value[] | undefined): readonly Value[] {
  return Object.freeze([...(input ?? [])])
}

function optionalFrozenList<Value>(get: () => readonly Value[] | undefined): readonly Value[] | undefined {
  return get() === undefined ? undefined : Object.freeze([...get()!])
}

function captureNativeTools(input: readonly NativeToolSchema[] | undefined): readonly NativeToolSchema[] {
  return Object.freeze((input ?? []).map(tool => Object.freeze({ ...tool })))
}

function captureCompaction(input: AgentDefinitionInput): AgentCompactionConfig | false {
  return input.compaction === false ? false : resolveCompactionConfig(input.compaction)
}

function captureProviderOptions(input: AgentDefinitionInput): AgentProviderOptions | undefined {
  return input.providerOptions === undefined ? undefined : Object.freeze({
    ...(input.providerOptions.headers === undefined ? {} : {
      headers: Object.freeze({ ...input.providerOptions.headers }),
    }),
    ...(input.providerOptions.body === undefined ? {} : { body: Object.freeze({ ...input.providerOptions.body }) }),
  })
}
