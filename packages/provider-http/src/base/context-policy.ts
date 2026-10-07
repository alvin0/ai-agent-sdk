import type { ModelContext, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
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
  info: ContextModelInfo,
  policy: ModelContextPolicy | undefined,
  configured?: ProviderCatalogModel,
  providerOverride?: number,
): ResolvedModelInfo {
  const defaultContextWindow = resolveDefaultWindow(info, policy, configured)
  const maxContextWindow = resolveMaximumWindow(info, policy, configured)
  const standardPriceInputTokens = resolveStandardPrice(info, policy, configured)
  const contextWindow = resolveContextWindow(info, configured, { providerOverride, defaultContextWindow })
  validateContextValues({ contextWindow, defaultContextWindow, maxContextWindow, standardPriceInputTokens })
  // A partial `context` with no `contextWindow` (e.g. only a route's own
  // `defaultContextWindow` hint, carried here so it can outrank correctly —
  // see `resolvedCatalogModelInfo`) is not a real `ModelContext` and must never
  // leak downstream as one.
  if (contextWindow === undefined) {
    const { context: _partial, ...withoutContext } = info
    return withoutContext
  }
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

type ContextModelInfo = Omit<ResolvedModelInfo, 'context'> & { readonly context?: Partial<ModelContext> }
type ContextValues = {
  contextWindow: number | undefined; defaultContextWindow: number | undefined;
  maxContextWindow: number | undefined; standardPriceInputTokens: number | undefined
}

function resolveDefaultWindow(
  info: ContextModelInfo, policy: ModelContextPolicy | undefined, configured: ProviderCatalogModel | undefined,
) {
  return configured?.defaultContextWindow ?? policy?.defaultContextWindow
    ?? info.context?.defaultContextWindow
}

function resolveMaximumWindow(
  info: ContextModelInfo, policy: ModelContextPolicy | undefined, configured: ProviderCatalogModel | undefined,
) {
  const knownMaximum = policy?.maxContextWindow ?? info.context?.maxContextWindow
  return knownMaximum === undefined
    ? configured?.maxContextWindow
    : Math.min(knownMaximum, configured?.maxContextWindow ?? knownMaximum)

}

function resolveStandardPrice(
  info: ContextModelInfo, policy: ModelContextPolicy | undefined, configured: ProviderCatalogModel | undefined,
) {
  return configured?.standardPriceInputTokens
    ?? policy?.standardPriceInputTokens
    ?? info.context?.standardPriceInputTokens
}

function resolveContextWindow(
  info: ContextModelInfo, configured: ProviderCatalogModel | undefined,
  values: { providerOverride: number | undefined; defaultContextWindow: number | undefined },
) {
  const { providerOverride, defaultContextWindow } = values
  return configured?.contextWindow ?? providerOverride ?? defaultContextWindow
    ?? info.context?.contextWindow
}

function validateContextValues(values: ContextValues): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  validateMaximumWindow(values)
}

function validateMaximumWindow(values: ContextValues): void {
  const { contextWindow, defaultContextWindow, maxContextWindow } = values
  if (maxContextWindow !== undefined && (
    (contextWindow !== undefined && contextWindow > maxContextWindow)
    || (defaultContextWindow !== undefined && defaultContextWindow > maxContextWindow)
  )) throw new RangeError('contextWindow exceeds maxContextWindow')

}
