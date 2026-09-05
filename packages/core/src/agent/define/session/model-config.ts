import type { AgentDefinition } from '../definition.ts'
import type { CallConfig } from '../../../contract/index.ts'
import type { RuntimeSessionConfiguration } from './runtime-binding.ts'

export function sessionCallConfig(
  definition: AgentDefinition,
  runtime: RuntimeSessionConfiguration | undefined,
): Pick<CallConfig, 'provider' | 'model' | 'reasoningEffort' | 'maxTokens'> {
  if (runtime !== undefined) return {
    provider: runtime.provider,
    model: runtime.model,
    ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
    ...(runtime.maxTokens === undefined ? {} : { maxTokens: runtime.maxTokens }),
  }
  return {
    provider: definition.provider,
    model: definition.model,
    reasoningEffort: definition.effort,
    ...(definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens }),
  }
}
