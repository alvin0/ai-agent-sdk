import type { DecisionAdapter } from './adapter.ts'
import { identifier } from './validation.ts'

export const DECISION_PROVIDER_PLUGIN_API_VERSION = 1 as const
export interface DecisionRegistrationHandle { dispose(): void }
export interface DecisionProviderRegistrar {
  registerAdapter(routes: readonly string[], adapter: DecisionAdapter): DecisionRegistrationHandle
}
export interface DecisionProviderPlugin {
  readonly kind: 'decision-provider-plugin'
  readonly apiVersion: typeof DECISION_PROVIDER_PLUGIN_API_VERSION
  readonly id: string
  readonly routes: readonly string[]
  readonly setup: (registrar: DecisionProviderRegistrar) => void | (() => void)
}
export function defineDecisionProviderPlugin(definition: Omit<DecisionProviderPlugin, 'kind' | 'apiVersion'>): DecisionProviderPlugin {
  identifier(definition.id, 'Plugin id')
  if (!Array.isArray(definition.routes) || definition.routes.length === 0 || new Set(definition.routes).size !== definition.routes.length) throw new Error('Decision plugin routes must be non-empty and unique')
  definition.routes.forEach(route => identifier(route, 'Provider route'))
  if (typeof definition.setup !== 'function') throw new Error('Decision plugin requires setup')
  return Object.freeze({ ...definition, routes: Object.freeze([...definition.routes]), kind: 'decision-provider-plugin', apiVersion: DECISION_PROVIDER_PLUGIN_API_VERSION })
}
