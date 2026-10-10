import type { ModelAdapter } from '../contract/adapter.ts'
import { ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import { PLUGIN_ERROR_CODES, PluginError, type AdapterRegistrationHandle,
  type ModelProviderPlugin, type ModelProviderRegistrar,
  type PluginRegistrationHandle, type StreamMiddleware } from '../plugin/provider-plugin.ts'
import type { RuntimeAdapterRegistration } from './model-stream.ts'

type AdapterRegistration = RuntimeAdapterRegistration
interface PluginOwner { readonly pluginId: string; readonly family: string }

export interface PluginInstallationHost {
  readonly adapters: Map<string, AdapterRegistration>
  readonly middleware: StreamMiddleware[]
  readonly plugins: Map<string, InstalledPlugin>
  prepareRoutes(routes: readonly string[], adapter: ModelAdapter, owned: ReadonlySet<string>,
    owner: PluginOwner): AdapterRegistration[]
  emitAdaptersUpdated(): void
}

interface StagedAdapter {
  active: boolean
  routes: string[]
  readonly adapter: ModelAdapter
}
interface StagedMiddleware { active: boolean; readonly middleware: StreamMiddleware }
interface PluginStage {
  readonly state: { staging: boolean }
  readonly registrar: ModelProviderRegistrar
  readonly stagedAdapters: StagedAdapter[]
  readonly stagedMiddleware: StagedMiddleware[]
}

export interface InstalledPlugin {
  readonly routes: ReadonlySet<string>
  readonly registrations: readonly AdapterRegistration[]
  readonly middleware: readonly StreamMiddleware[]
  readonly cleanup?: () => void
}


function containThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  let then: unknown
  try {
    then = Reflect.get(value, 'then')
  } catch {
    return true
  }
  if (typeof then !== 'function') return false
  try { void Promise.resolve(value).catch(() => {}) } catch { /* hostile thenable contained */ }
  return true
}

function synchronousCleanupFailure(cleanup: () => void): unknown | undefined {
  try {
    const result: unknown = cleanup()
    return containThenable(result) ? new TypeError('plugin cleanup must be synchronous') : undefined
  } catch (error) {
    return error
  }
}


class PluginInstallation {
  private readonly pluginId: string
  constructor(private readonly plugin: ModelProviderPlugin, private readonly host: PluginInstallationHost) {
    this.pluginId = typeof plugin?.id === 'string' ? plugin.id : ''
  }

  run(): PluginRegistrationHandle {
    const owner = this.validateIdentity()
    const stage = this.createStaging(owner)
    const cleanup = this.setup(stage)
    const prepared = this.prepareCommit(stage, owner, cleanup)
    const installed = this.commit(stage, prepared, cleanup)
    return this.disposer(installed)
  }

  private fail(message: string, cause?: unknown, cleanupFailures: readonly unknown[] = []): never {
    const pluginId = this.pluginId
    const causes = [...cause === undefined ? [] : [cause], ...cleanupFailures]
    const wrappedCause = causes.length <= 1 ? causes[0] : new AggregateError(causes,
      `plugin ${pluginId} install cleanup failed`)
    throw new PluginError(message, PLUGIN_ERROR_CODES.INSTALL_FAILED, pluginId,
      wrappedCause === undefined ? undefined : { cause: wrappedCause })
  }

  private validateIdentity() {
    const { plugin, pluginId } = this
    if (pluginId.trim().length === 0
      || pluginId !== pluginId.trim()) this.fail('plugin id must be a non-empty trimmed string')
    if (this.host.plugins.has(pluginId)) this.fail(`plugin "${pluginId}" is already installed`)
    if (typeof plugin.displayName !== 'string'
      || plugin.displayName.trim().length === 0) this.fail(`plugin "${pluginId}" displayName must be non-empty`)
    if (typeof plugin.setup !== 'function') this.fail(`plugin "${pluginId}" setup must be a function`)
    return this.captureOwner()
  }

  private captureOwner() {
    const { plugin, pluginId } = this
    const family = plugin.family ?? pluginId
    if (typeof family !== 'string' || family.trim().length === 0 || family !== family.trim()) {
      this.fail(`plugin "${pluginId}" family must be a non-empty trimmed string`)
    }
    return Object.freeze({ pluginId, family })
  }

  private createStaging(owner: PluginOwner) {
    const pluginId = this.pluginId
    const fail = (message: string): never => this.fail(message)
    const stagedAdapters: StagedAdapter[] = []
    const stagedMiddleware: StagedMiddleware[] = []
    const state = { staging: true }

    const registrar: ModelProviderRegistrar = {
      registerAdapter: (routes, adapter) => {
        if (!state.staging) fail(`plugin "${pluginId}" staging registrar is closed`)
        if (routes.length === 0) throw new ModelError('an adapter must register at least one provider route',
          REGISTRY_ERROR_CODES.INVALID_ADAPTER)
        const item: StagedAdapter = { active: true, routes: [...routes], adapter }
        // Validate metadata and conflicts without mutating live routes.
        const occupied = new Set(stagedAdapters.filter(value => value.active).flatMap(value => value.routes))
        for (const route of routes) if (occupied.has(route)) {
          throw new ModelError(`an adapter for provider route "${route}" is already staged`,
            REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
        }
        this.host.prepareRoutes(routes, adapter, new Set(), owner)
        stagedAdapters.push(item)
        const handle = (() => {
          if (state.staging) item.active = false
        }) as AdapterRegistrationHandle
        handle.replace = (next) => {
          if (!state.staging || !item.active) throw new ModelError(
            'a disposed staged registration cannot replace routes',
            REGISTRY_ERROR_CODES.REGISTRATION_DISPOSED)
          const occupiedByOthers = new Set(stagedAdapters.filter(value => value.active
            && value !== item).flatMap(value => value.routes))
          for (const route of next) if (occupiedByOthers.has(route)) {
            throw new ModelError(`an adapter for provider route "${route}" is already staged`,
              REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
          }
          this.host.prepareRoutes(next, adapter, new Set(), owner)
          item.routes = [...next]
        }
        return handle
      },
      use: (middleware) => {
        if (!state.staging) fail(`plugin "${pluginId}" staging registrar is closed`)
        if (typeof middleware !== 'function') throw new TypeError('plugin middleware must be a function')
        const item: StagedMiddleware = { active: true, middleware }
        stagedMiddleware.push(item)
        return () => { if (state.staging) item.active = false }
      },
    }
    return { state, registrar, stagedAdapters, stagedMiddleware }
  }

  private setup(stage: PluginStage): (() => void) | undefined {
    const pluginId = this.pluginId
    const fail = (message: string, cause?: unknown): never => this.fail(message, cause)
    let cleanup: (() => void) | undefined
    try {
      const result = this.plugin.setup(stage.registrar)
      if (containThenable(result)) fail(`plugin "${pluginId}" setup must be synchronous`)
      if (result !== undefined
        && typeof result !== 'function') fail(
          `plugin "${pluginId}" setup must be synchronous and return void or cleanup`)
      cleanup = typeof result === 'function' ? result : undefined
    } catch (error) {
      if (error instanceof PluginError && error.code === PLUGIN_ERROR_CODES.INSTALL_FAILED) throw error
      fail(`plugin "${pluginId}" setup failed`, error)
    } finally {
      stage.state.staging = false
    }
    return cleanup
  }

  private prepareCommit(stage: PluginStage, owner: PluginOwner, cleanup: (() => void) | undefined) {
    const pluginId = this.pluginId
    const fail = (message: string, cause: unknown, failures: readonly unknown[]): never =>
      this.fail(message, cause, failures)
    const registrations: AdapterRegistration[] = []
    const routeNames = new Set<string>()
    try {
      for (const item of stage.stagedAdapters) {
        if (!item.active) continue
        for (const route of item.routes) {
          if (routeNames.has(route)) throw new ModelError(
            `an adapter for provider route "${route}" is already staged`, REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
          routeNames.add(route)
        }
        registrations.push(...this.host.prepareRoutes(item.routes, item.adapter, new Set(), owner))
      }
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (cleanup) {
        const cleanupFailure = synchronousCleanupFailure(cleanup)
        if (cleanupFailure !== undefined) cleanupFailures.push(cleanupFailure)
      }
      fail(`plugin "${pluginId}" commit validation failed`, error, cleanupFailures)
    }
    return { registrations, routeNames }
  }

  private commit(
    stage: PluginStage, prepared: ReturnType<PluginInstallation['prepareCommit']>, cleanup: (() => void) | undefined,
  ): InstalledPlugin {
    const pluginId = this.pluginId
    const { registrations, routeNames } = prepared
    const committedMiddleware = stage.stagedMiddleware.filter(item => item.active).map(item => item.middleware)
    for (const registration of registrations) this.host.adapters.set(registration.provider.id, registration)
    this.host.middleware.push(...committedMiddleware)
    const installed: InstalledPlugin = {
      routes: routeNames,
      registrations,
      middleware: committedMiddleware,
      ...(cleanup === undefined ? {} : { cleanup }),
    }
    this.host.plugins.set(pluginId, installed)
    this.host.emitAdaptersUpdated()
    return installed
  }

  private disposer(installed: InstalledPlugin): PluginRegistrationHandle {
    const pluginId = this.pluginId
    let disposed = false
    const dispose = (() => {
      if (disposed) return
      disposed = true
      this.host.plugins.delete(pluginId)
      for (const registration of installed.registrations) {
        if (this.host.adapters.get(registration.provider.id) === registration) {
          this.host.adapters.delete(registration.provider.id)
        }
      }
      for (let index = installed.middleware.length - 1; index >= 0; index--) {
        const middleware = installed.middleware[index]
        const liveIndex = middleware === undefined ? -1 : this.host.middleware.lastIndexOf(middleware)
        if (liveIndex >= 0) this.host.middleware.splice(liveIndex, 1)
      }
      this.host.emitAdaptersUpdated()
      const failures: unknown[] = []
      if (installed.cleanup) {
        const cleanupFailure = synchronousCleanupFailure(installed.cleanup)
        if (cleanupFailure !== undefined) failures.push(cleanupFailure)
      }
      if (failures.length > 0) {
        throw new PluginError(
          `plugin "${pluginId}" cleanup failed`,
          PLUGIN_ERROR_CODES.CLEANUP_FAILED,
          pluginId,
          { cause: new AggregateError(failures, `plugin "${pluginId}" cleanup failed`) },
        )
      }
    }) as PluginRegistrationHandle
    Object.defineProperty(dispose, 'pluginId', { value: pluginId, enumerable: true })
    return dispose
  }
}

export function installProviderPlugin(
  plugin: ModelProviderPlugin, host: PluginInstallationHost,
): PluginRegistrationHandle {
  return new PluginInstallation(plugin, host).run()
}
