import {
  cloneAgent as cloneAdvancedAgent,
  defineAgent as defineAdvancedAgent,
  type AgentDefinition,
  type AgentDefinitionInput,
  type CloneAgentOverrides,
  type DefinedAgent,
} from '../../agent/define/definition.ts'
import { objectValue, ownData } from '../common/data.ts'
import { cloneRuntimeAgentDefinition, defineRuntimeAgentDefinition } from './definition.ts'
import type { RuntimeAgentDefinition, RuntimeAgentDefinitionInput } from './types.ts'

export function defineAgent(input: RuntimeAgentDefinitionInput): RuntimeAgentDefinition
export function defineAgent(input: AgentDefinitionInput): DefinedAgent
export function defineAgent(
  input: AgentDefinitionInput | RuntimeAgentDefinitionInput,
): DefinedAgent | RuntimeAgentDefinition {
  return runtimeDiscriminant(input)
    ? defineRuntimeAgentDefinition(input as RuntimeAgentDefinitionInput)
    : defineAdvancedAgent(input as AgentDefinitionInput)
}

export function cloneAgent(source: AgentDefinition, overrides: CloneAgentOverrides): DefinedAgent
export function cloneAgent(
  source: RuntimeAgentDefinition,
  overrides: Partial<Omit<RuntimeAgentDefinitionInput, 'id'>> & { readonly id: string },
): RuntimeAgentDefinition
export function cloneAgent(
  source: AgentDefinition | RuntimeAgentDefinition,
  overrides: CloneAgentOverrides | (Partial<Omit<RuntimeAgentDefinitionInput, 'id'>> & { readonly id: string }),
): DefinedAgent | RuntimeAgentDefinition {
  return runtimeDiscriminant(source)
    ? cloneRuntimeAgentDefinition(source as RuntimeAgentDefinition,
      overrides as Partial<Omit<RuntimeAgentDefinitionInput, 'id'>> & { readonly id: string })
    : cloneAdvancedAgent(source as AgentDefinition, overrides as CloneAgentOverrides)
}

function runtimeDiscriminant(value: unknown): boolean {
  const source = objectValue(value)
  const model = ownData(source, 'model', false)
  if (model === undefined || typeof model === 'string') return false
  if (typeof model === 'object' && model !== null && !Array.isArray(model)) return true
  throw new TypeError('Agent model must be a string, a model target object, or omitted')
}
