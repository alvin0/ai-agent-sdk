import type { CallConfig, ResolvedModelInfo } from '../../contract/index.ts'
import type { AgentCompactionConfig } from './compaction-config.ts'
import { defaultOutputTokens } from '../../runtime/model-metadata.ts'

export interface ResolvedBudget {
  readonly thresholdTokens: number
  readonly retainTokens: number
}
type ModelBudget = { readonly contextWindow: number; readonly outputReserve: number }

export function modelCompactionBudget(config: CallConfig, info: ResolvedModelInfo): ModelBudget | null {
  // Keep agent context-window precedence aligned with call resolution.
  const contextWindow = config.contextWindow ?? info.context?.contextWindow
  if (contextWindow === undefined) return null
  return {
    contextWindow,
    outputReserve: config.maxTokens ?? defaultOutputTokens(info, {}, contextWindow)
      ?? Math.min(info.maxOutputTokens ?? 0, Math.floor(contextWindow / 2)),
  }
}

export function resolveCompactionBudget(
  policy: AgentCompactionConfig,
  budget: ModelBudget | null | undefined,
  totalTokens: number,
): ResolvedBudget | null {
  const contextWindow = budget?.contextWindow
  const inputWindow = contextWindow === undefined
    ? undefined
    : Math.max(1, contextWindow - (budget?.outputReserve ?? 0))
  const thresholdTokens = compactionThreshold(policy, contextWindow, inputWindow)
  if (thresholdTokens === undefined) return null
  const inferredWindow = inputWindow ?? Math.max(totalTokens, Math.ceil(thresholdTokens / policy.thresholdRatio))
  const retainTokens = policy.retainTokens ?? Math.floor(inferredWindow * (policy.retainRatio ?? 0.2))
  return { thresholdTokens, retainTokens: Math.max(1, retainTokens) }
}

function compactionThreshold(
  policy: AgentCompactionConfig,
  contextWindow: number | undefined,
  inputWindow: number | undefined,
): number | undefined {
  const ratioThreshold = contextWindow === undefined ? undefined : Math.floor(contextWindow * policy.thresholdRatio)
  const safeThreshold = inputWindow === undefined || ratioThreshold === undefined
    ? undefined : Math.min(inputWindow, ratioThreshold)
  if (policy.maxInputTokens === undefined) return safeThreshold
  if (inputWindow === undefined) return policy.maxInputTokens
  return Math.min(policy.maxInputTokens, inputWindow)
}
