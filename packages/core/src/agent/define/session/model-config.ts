import type { AgentDefinition } from '../definition.ts'
import type { CallConfig } from '../../../contract/index.ts'
import type { RuntimeSessionConfiguration } from './runtime-binding.ts'
import type { AgentInvocationOptions } from './types.ts'

export type SessionCallConfig = Pick<CallConfig, 'provider' | 'model' | 'reasoningEffort' | 'maxTokens'>

/**
 * The model binding for ONE run: the session's binding, then the invocation's
 * overlay on top of it.
 *
 * Switching model and inheriting the previous model's controls is not a
 * conservative default, it is a broken one: an effort or an output ceiling is a
 * property of the model that offers it, and carrying either onto a different
 * model produces `UNSUPPORTED_REASONING_EFFORT` or
 * `OUTPUT_TOKEN_LIMIT_EXCEEDED` at dispatch. So a model override drops the
 * inherited effort and maxTokens unless the same invocation restates them, and
 * omission means the adapter's own default — the same rule the session binding
 * already follows. An effort-only override keeps the session's model, which is
 * the point of asking for a different effort.
 */
export function sessionCallConfig(
  definition: AgentDefinition,
  runtime: RuntimeSessionConfiguration | undefined,
  invocation?: Pick<AgentInvocationOptions, 'model' | 'reasoningEffort' | 'maxTokens'>,
): SessionCallConfig {
  const base: SessionCallConfig = runtime !== undefined
    ? {
        provider: runtime.provider,
        model: runtime.model,
        ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
        ...(runtime.maxTokens === undefined ? {} : { maxTokens: runtime.maxTokens }),
      }
    : {
        provider: definition.provider,
        model: definition.model,
        // Omitted when the author expressed no preference: a value the SDK invented
        // is rejected outright by a model that declares no ladder.
        ...(definition.effort === undefined ? {} : { reasoningEffort: definition.effort }),
        ...(definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens }),
      }
  const target = invocation?.model
  if (target === undefined && invocation?.reasoningEffort === undefined && invocation?.maxTokens === undefined) {
    return base
  }
  const switched = target !== undefined
    && (target.provider !== base.provider || target.model !== base.model)
  const reasoningEffort = invocation?.reasoningEffort ?? (switched ? undefined : base.reasoningEffort)
  const maxTokens = invocation?.maxTokens ?? (switched ? undefined : base.maxTokens)
  return {
    provider: target?.provider ?? base.provider,
    model: target?.model ?? base.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}
