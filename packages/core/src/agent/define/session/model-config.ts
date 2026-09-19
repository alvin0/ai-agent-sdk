import type { AgentDefinition } from '../definition.ts'
import type { CallConfig } from '../../../contract/index.ts'
import type { RuntimeSessionConfiguration } from './runtime-binding.ts'
import type { AgentInvocationOptions } from './types.ts'

export type SessionCallConfig = Pick<CallConfig,
  'provider' | 'model' | 'reasoningEffort' | 'maxTokens' | 'contextWindow' | 'inputModalities'>

/**
 * The model binding for ONE run: the session's binding, then the invocation's
 * overlay on top of it.
 *
 * Effort belongs to the agent, not to a single run: there is no per-invocation
 * effort override, so the only way effort changes is by defining a different
 * agent. Switching model on one invocation still drops the inherited effort —
 * an effort belongs to the model that offers it, and carrying it onto a
 * different model would be a guess this package has no way to validate, now
 * that effort is pure pass-through. maxTokens follows the same drop-on-switch
 * rule, but stays overridable per invocation like today.
 *
 * contextWindow/inputModalities are a fact about the agent's own
 * configuration, not about a specific model's ladder, so they always come
 * from `definition` (never `runtime`) and survive a model switch instead of
 * being dropped like effort/maxTokens.
 */
export function sessionCallConfig(
  definition: AgentDefinition,
  runtime: RuntimeSessionConfiguration | undefined,
  invocation?: Pick<AgentInvocationOptions, 'model' | 'maxTokens'>,
): SessionCallConfig {
  const agentTier = {
    ...(definition.contextWindow === undefined ? {} : { contextWindow: definition.contextWindow }),
    ...(definition.inputModalities === undefined ? {} : { inputModalities: definition.inputModalities }),
  }
  const base: SessionCallConfig = runtime !== undefined
    ? {
        provider: runtime.provider,
        model: runtime.model,
        ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
        ...(runtime.maxTokens === undefined ? {} : { maxTokens: runtime.maxTokens }),
        ...agentTier,
      }
    : {
        provider: definition.provider,
        model: definition.model,
        ...(definition.effort === undefined ? {} : { reasoningEffort: definition.effort }),
        ...(definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens }),
        ...agentTier,
      }
  const target = invocation?.model
  if (target === undefined && invocation?.maxTokens === undefined) {
    return base
  }
  const switched = target !== undefined
    && (target.provider !== base.provider || target.model !== base.model)
  const reasoningEffort = switched ? undefined : base.reasoningEffort
  const maxTokens = invocation?.maxTokens ?? (switched ? undefined : base.maxTokens)
  return {
    provider: target?.provider ?? base.provider,
    model: target?.model ?? base.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...agentTier,
  }
}
