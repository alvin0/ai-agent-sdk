import type { AgentDefinitionInput } from './definition.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { SKILL_TOOL_NAMES, validateSkillId, validateSkillSource } from '../skill/index.ts'

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export function validateDefinition(input: AgentDefinitionInput): void {
  validateIdentity(input)
  validateTurns(input)
  validateModelBounds(input)
  validateModalities(input)
  validateToolCallLimit(input)
  const names = validateHostTools(input)
  validateNativeTools(input, names)
  validateReservedNames(input, names)
  validateSkillIds(input)
  validateSkillSources(input)
}

function validateIdentity(input: AgentDefinitionInput): void {
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
}

function validateTurns(input: AgentDefinitionInput): void {
  if (input.maxTurns !== undefined && input.maxTurns !== 'auto'
    && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) {
    throw new RangeError("agent maxTurns must be a positive safe integer or 'auto'")
  }
}

function validateModelBounds(input: AgentDefinitionInput): void {
  if (input.maxTokens !== undefined
    && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new RangeError('agent maxTokens must be a positive safe integer')
  }
  if (input.contextWindow !== undefined
    && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)) {
    throw new RangeError('agent contextWindow must be a positive safe integer')
  }
}

function validateModalities(input: AgentDefinitionInput): void {
  if (input.inputModalities !== undefined
    && (input.inputModalities.length === 0
      || new Set(input.inputModalities).size !== input.inputModalities.length)) {
    throw new RangeError('agent inputModalities must be non-empty and unique')
  }
}

function validateToolCallLimit(input: AgentDefinitionInput): void {
  if (input.maxToolCalls !== undefined
    && (!Number.isInteger(input.maxToolCalls) || input.maxToolCalls < 1)) {
    throw new RangeError('agent maxToolCalls must be a positive integer')
  }
}

function validateHostTools(input: AgentDefinitionInput): Set<string> {
  const names = new Set<string>()
  for (const tool of input.tools ?? []) {
    validateHostTool(tool)
    if (names.has(tool.name)) throw new TypeError(`agent has duplicate host tool '${tool.name}'`)
    names.add(tool.name)
  }
  return names
}

function validateHostTool(tool: ToolDefinition<any>): void {
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
  validateHostToolTimeout(tool)
}

function validateHostToolTimeout(tool: ToolDefinition<any>): void {
    if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)) {
      throw new RangeError(`agent host tool '${tool.name}' must have a positive timeoutMs`)
    }
}

function validateNativeTools(input: AgentDefinitionInput, names: Set<string>): void {
  for (const tool of input.nativeTools ?? []) {
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
      throw new TypeError('agent native tools must have a non-empty name')
    }
    if (names.has(tool.name)) throw new TypeError(`agent has duplicate tool '${tool.name}'`)
    names.add(tool.name)
  }
}

function validateReservedNames(input: AgentDefinitionInput, names: ReadonlySet<string>): void {
  if ((input.skills?.length ?? 0) > 0 || (input.skillIds?.length ?? 0) > 0) {
    for (const reserved of SKILL_TOOL_NAMES) {
      if (names.has(reserved)) throw new TypeError(`agent tool '${reserved}' collides with the skill runtime`)
    }
  }
}

function validateSkillIds(input: AgentDefinitionInput): void {
  const allowedSkills = new Set<string>()
  for (const id of input.skillIds ?? []) {
    validateSkillId(id, 'agent skill')
    if (allowedSkills.has(id)) throw new TypeError(`agent has duplicate allowed skill '${id}'`)
    allowedSkills.add(id)
  }
}

function validateSkillSources(input: AgentDefinitionInput): void {
  const directSkills = new Set<string>()
  const providers = new Set<string>()
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
