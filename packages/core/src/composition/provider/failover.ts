import type { ModelAdapter } from '../../contract/adapter.ts'
import type {
  AdapterRegistrationHandle, ModelProviderPlugin, ModelProviderRegistrar,
} from '../../plugin/provider-plugin.ts'
import { withFailover, type FailoverMember, type WithFailoverOptions } from '../../runtime/with-failover.ts'
import { defineModelProviderPlugin } from './definition.ts'
import type { ComposableModelProviderPlugin, ComposableModelProviderRegistrar, ModelTarget } from './types.ts'

/** One member of a {@link failoverProviderPlugin}: a provider plugin set up only for this route. */
export interface FailoverProviderMember {
  /**
   * The member's provider plugin, e.g. a Codex or Copilot plugin bound to one
   * account's credential store, or an API-key provider. Give each instance its
   * own `id`; it is set up privately and its routes are not exposed. Its `setup`
   * must be synchronous. Middleware it installs with `use` applies to the whole
   * runtime, as it would if the plugin were installed directly.
   */
  readonly plugin: ModelProviderPlugin
  /** Which of the plugin's routes serves this member; defaults to its first. */
  readonly route?: string
  /** Model id to request from this member; defaults to the id the agent asked for. */
  readonly model?: string
  /**
   * Name in failover events, and the key its replay state is kept under; defaults
   * to `route`, then the plugin id. Must be distinct across members.
   */
  readonly id?: string
}

/** Options for {@link failoverProviderPlugin}. */
export interface FailoverProviderOptions extends Omit<WithFailoverOptions, 'displayName' | 'now'> {
  /** Plugin id; also the route agents select unless `routes` is given. */
  readonly id: string
  readonly displayName?: string
  readonly routes?: readonly string[]
  /** Model used when an agent names only the route. */
  readonly defaultModel?: string | ModelTarget
  /** In priority order: the first available member serves each call. */
  readonly members: readonly FailoverProviderMember[]
}

interface CapturedRegistration {
  routes: readonly string[]
  readonly adapter: ModelAdapter
}

/**
 * One route served by several provider plugins in priority order, so an expired
 * or rejected credential, an exhausted quota, a rate limit or an outage moves
 * calls to the next member instead of failing them (see {@link withFailover}).
 * Members can be accounts of one provider (several Codex or Copilot logins) or
 * different providers; they should serve equivalent models.
 * @param options - route, members and failover policy.
 * @returns a composable provider plugin; install it like any other provider.
 */
export function failoverProviderPlugin(options: FailoverProviderOptions): ComposableModelProviderPlugin {
  if (options.members.length === 0) throw new TypeError('failoverProviderPlugin requires at least one member')
  const routes = Object.freeze([...options.routes ?? [options.id]])
  const defaultModel = typeof options.defaultModel === 'string'
    ? routeDefault(options.defaultModel, routes) : options.defaultModel
  const members = Object.freeze([...options.members])
  const ids = members.map((member, index) => member.id ?? member.route ?? member.plugin.id ?? String(index))
  if (new Set(ids).size !== ids.length) throw new TypeError('failoverProviderPlugin members need distinct ids')
  return defineModelProviderPlugin({
    id: options.id,
    displayName: options.displayName ?? options.id,
    family: 'failover',
    routes,
    ...defaultModel === undefined ? {} : { defaultModel },
    setup(registrar) {
      const cleanups: (() => void)[] = []
      try {
        const served = members.map((member, index) => setUpMember(member, ids[index]!, registrar, cleanups))
        registrar.registerAdapter(withFailover(served, {
          displayName: options.displayName ?? options.id,
          ...options.shouldFailover === undefined ? {} : { shouldFailover: options.shouldFailover },
          ...options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs },
          ...options.onFailover === undefined ? {} : { onFailover: options.onFailover },
        }))
      } catch (error: unknown) {
        // The setup failure is what the caller needs; a rollback failure would hide it.
        try { runCleanups(cleanups) } catch { /* rollback is best effort */ }
        throw error
      }
      return () => {
        runCleanups(cleanups)
        return undefined
      }
    },
  })
}

function setUpMember(
  member: FailoverProviderMember, id: string, registrar: ComposableModelProviderRegistrar,
  cleanups: (() => void)[],
): FailoverMember {
  const captured: CapturedRegistration[] = []
  const cleanup: unknown = member.plugin.setup(privateRegistrar(registrar, captured))
  if (isPromiseLike(cleanup)) {
    // Its routes would be registered after the failover adapter was built; run its cleanup when it settles.
    void Promise.resolve(cleanup).then((late) => { if (typeof late === 'function') late() }).catch(() => undefined)
    throw new TypeError(`failover member ${JSON.stringify(member.plugin.id)} setup must be synchronous`)
  }
  if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  const { route, registration } = memberRegistration(member, captured)
  return {
    adapter: registration.adapter, provider: route,
    ...member.model === undefined ? {} : { model: member.model },
    // The id checked for uniqueness: it also keys each member's replay state.
    id,
  }
}

/** The adapter the member registered for the route it serves. */
function memberRegistration(
  member: FailoverProviderMember, captured: readonly CapturedRegistration[],
): { readonly route: string; readonly registration: CapturedRegistration } {
  const declared = (member.plugin as Partial<ComposableModelProviderPlugin>).routes
  const route = member.route ?? declared?.[0] ?? captured[0]?.routes[0]
  const registration = route === undefined ? undefined : captured.find(entry => entry.routes.includes(route))
  if (route === undefined || registration === undefined) {
    throw new TypeError(`failover member ${JSON.stringify(member.plugin.id)} registered no adapter for `
      + `route ${JSON.stringify(route ?? '<none>')}`)
  }
  return { route, registration }
}

/** The member registers into this private view, never into the runtime's route table. */
function privateRegistrar(
  registrar: ComposableModelProviderRegistrar, captured: CapturedRegistration[],
): ModelProviderRegistrar & { readonly logger: ComposableModelProviderRegistrar['logger'] } {
  return {
    logger: registrar.logger,
    registerAdapter(routes, adapter): AdapterRegistrationHandle {
      const entry: CapturedRegistration = { routes: Object.freeze([...routes]), adapter }
      captured.push(entry)
      return Object.assign(() => {
        const index = captured.indexOf(entry)
        if (index >= 0) captured.splice(index, 1)
      }, { replace(next: readonly string[]) { entry.routes = Object.freeze([...next]) } })
    },
    use: middleware => registrar.use(middleware),
  }
}

/** Runs every cleanup, newest first; one member's failure does not strand the others, and is rethrown after. */
function runCleanups(cleanups: readonly (() => void)[]): void {
  const errors: unknown[] = []
  for (const cleanup of [...cleanups].reverse()) {
    try { cleanup() } catch (error: unknown) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'failover member cleanups failed')
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}

function routeDefault(model: string, routes: readonly string[]): ModelTarget {
  if (routes.length !== 1) throw new TypeError('A string defaultModel requires exactly one failover route')
  return Object.freeze({ provider: routes[0]!, id: model })
}
