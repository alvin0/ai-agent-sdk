import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import type { ProviderCatalogModel } from './http-adapter.ts'

/** Context facts only: never advertises models or guesses their capabilities. */
export interface ModelContextPolicy {
  readonly defaultContextWindow: number
  readonly maxContextWindow?: number
  readonly standardPriceInputTokens?: number
}

export interface ModelContextPolicyOptions {
  readonly baseUrl?: string
  readonly models?: readonly ProviderCatalogModel[]
  readonly defaultContextWindow?: number
}

export function applyModelContextPolicy(
  info: ResolvedModelInfo,
  policy: ModelContextPolicy | undefined,
  configured?: ProviderCatalogModel,
  providerOverride?: number,
): ResolvedModelInfo {
  const defaultContextWindow = configured?.defaultContextWindow ?? policy?.defaultContextWindow ?? info.context?.defaultContextWindow
  const knownMaximum = policy?.maxContextWindow ?? info.context?.maxContextWindow
  const maxContextWindow = knownMaximum === undefined
    ? configured?.maxContextWindow
    : Math.min(knownMaximum, configured?.maxContextWindow ?? knownMaximum)
  const standardPriceInputTokens = configured?.standardPriceInputTokens ?? policy?.standardPriceInputTokens ?? info.context?.standardPriceInputTokens
  const contextWindow = configured?.contextWindow ?? providerOverride ?? defaultContextWindow ?? info.context?.contextWindow
  for (const [name, value] of Object.entries({ contextWindow, defaultContextWindow, maxContextWindow, standardPriceInputTokens })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (maxContextWindow !== undefined && (
    (contextWindow !== undefined && contextWindow > maxContextWindow)
    || (defaultContextWindow !== undefined && defaultContextWindow > maxContextWindow)
  )) throw new RangeError('contextWindow exceeds maxContextWindow')
  if (contextWindow === undefined) return info
  return { ...info, context: {
    contextWindow,
    ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
    ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
    ...(standardPriceInputTokens === undefined ? {} : { standardPriceInputTokens }),
    ...(standardPriceInputTokens !== undefined && contextWindow > standardPriceInputTokens
      ? { pricingWarning: 'extended-context-may-cost-more' as const } : {}),
  } }
}

/** Capture configuration so later caller mutations cannot change model resolution. */
export function createModelContextPolicy(
  policies: Readonly<Record<string, ModelContextPolicy>>,
  models: readonly ProviderCatalogModel[] | undefined,
  providerOverride?: number,
): (info: ResolvedModelInfo) => ResolvedModelInfo {
  const captured = structuredClone(policies)
  const configured = structuredClone(models ?? [])
  return info => applyModelContextPolicy(info,
    Object.hasOwn(captured, info.id) ? captured[info.id] : undefined,
    configured.find(model => model.id === info.id), providerOverride)
}
