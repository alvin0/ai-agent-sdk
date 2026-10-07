import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { ModelAdapter } from '../../contract/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { AdapterRegistrationHandle, ModelProviderRegistrar,
  StreamMiddleware } from '../../plugin/provider-plugin.ts'
import type { ModelRegistry } from '../../runtime/registry.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText } from '../common/data.ts'
import { AgentRuntimeConstructionError, checkPreflightAbort } from '../common/errors.ts'
import type { RuntimeComponentCloseReport, RuntimeConstructionFailureCode } from '../common/errors.ts'
import type { CapturedProvider } from './types.ts'
import { beginCoreCapabilityOperation } from '../logging/capability.ts'

interface RouteRegistration {
  active: boolean
  routes: readonly string[]
}

export interface RuntimeProviderRegistrar extends ModelProviderRegistrar {
  readonly logger: SdkLogger
}

export interface ProviderRegistration {
  readonly id: string
  close(deadline?: ProviderCleanupDeadline): RuntimeComponentCloseReport
}

export interface ProviderCleanupDeadline {
  readonly at: number
  readonly now: () => number
}

export interface ProviderActivationDeadlines {
  readonly startup: ProviderCleanupDeadline
  readonly rollback: () => ProviderCleanupDeadline
}

/**
 * The ONE rollback list, shared across both provider plugin kinds.
 *
 * Generation and embedding plugins are separate objects with separate `install()`
 * calls, so no registry transaction spans them. What makes startup look atomic
 * from outside is that both activations append to the same `installed` array and
 * every failure path rolls back that whole array in reverse order — a generation
 * registration is released when a LATER embedding plugin fails, and the other way
 * round (Requirement 11.7).
 *
 * Omit it and an activation owns a private list, which is what a single-kind
 * caller wants.
 */
export interface SharedProviderActivation {
  readonly installed: ProviderRegistration[]
}

export const providerLifecycleError = () => new AgentSdkError('Provider registration is outside setup or cleanup',
  'PROVIDER_REGISTRAR_SEALED')
export const providerClaimError = () => new AgentSdkError(
  'Provider registration must cover its declared routes exactly once', 'PROVIDER_CLAIMS_INVALID',
)
const lifecycleError = providerLifecycleError
const claimError = providerClaimError

/** Reject and observe asynchronous returns without reading a then property a second time. */
export function asynchronous(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  let then: unknown
  try { then = Reflect.get(value, 'then') } catch { return true }
  if (typeof then !== 'function') return false
  void new Promise((resolve, reject) => { Reflect.apply(then, value, [resolve, reject]) }).catch(() => undefined)
  return true
}

export type CleanupCode =
  | 'CAPABILITY_CLEANUP_FAILED' | 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED' | 'CAPABILITY_CLEANUP_TIMEOUT'

export function closeRow(id: string, code?: CleanupCode): RuntimeComponentCloseReport {
  return Object.freeze({
    kind: 'provider-registration', id,
    status: cleanupStatus(code),
    ...(code !== undefined ? { error: Object.freeze({
      code, stage: 'provider-cleanup', message: 'Provider cleanup did not complete synchronously',
    }) } : {}),
  })
}

/**
 * Activate already-captured providers. The caller owns bus/exporter startup and the overall deadline.
 *
 * @param shared - the cross-kind rollback list; omit for a private one.
 * @returns every registration in `shared.installed`, this activation's included,
 *   so the caller can hand one list to the runtime regardless of how many kinds
 *   contributed to it.
 */
interface ProviderActivationOptions {
  readonly signal?: AbortSignal | undefined
  readonly deadlines?: ProviderActivationDeadlines | undefined
  readonly shared?: SharedProviderActivation | undefined
}

export function activateProviders(
  registry: ModelRegistry,
  providers: readonly CapturedProvider[],
  logger: SdkLogger,
  options: ProviderActivationOptions = {},
): readonly ProviderRegistration[] {
  const { signal, deadlines, shared } = options
  checkPreflightAbort(signal)
  const installed: ProviderRegistration[] = shared?.installed ?? []
  const idOffset = installed.length
  for (const [index, provider] of providers.entries()) {
    new ProviderActivation({
      registry, provider, logger, signal, deadlines, installed, index: idOffset + index,
    }).install()
  }
  return Object.freeze([...installed])
}

interface ActivationInput {
  registry: ModelRegistry
  provider: CapturedProvider
  logger: SdkLogger
  signal: AbortSignal | undefined
  deadlines: ProviderActivationDeadlines | undefined
  installed: ProviderRegistration[]
  index: number
}

class ProviderActivation {
  private phase: 'setup' | 'sealed' | 'cleanup' | 'closed' = 'setup'
  private failureCode: RuntimeConstructionFailureCode = 'CAPABILITY_STARTUP_FAILED'
  private failureCleanup: RuntimeComponentCloseReport | undefined
  private cleanup: (() => void) | undefined
  private cleaned = false
  private committed = false
  private cleanupDeadline: ProviderCleanupDeadline | undefined
  private failureWasAbort: boolean | undefined
  private readonly setupOperation: ReturnType<typeof beginCoreCapabilityOperation>
  private readonly reportId: string
  private readonly input: ActivationInput

  constructor(input: ActivationInput) {
    this.input = input
    this.setupOperation = beginCoreCapabilityOperation(
      input.logger.child({ providerIndex: input.index }), 'core-provider', 'setup',
    )
    this.reportId = `provider-${input.index}`
  }

  install(): void {
    try {
      checkPreflightAbort(this.input.signal)
      if (this.input.deadlines !== undefined && this.input.deadlines.startup.now() >= this.input.deadlines.startup.at) {
        this.failureCode = 'CAPABILITY_STARTUP_TIMEOUT'
        throw new Error('Provider startup deadline exhausted')
      }
      const dispose = this.input.registry.install({
        id: this.input.provider.id, displayName: this.input.provider.displayName, family: this.input.provider.family,
        setup: upstream => this.setup(upstream),
      })
      this.committed = true
      let report: RuntimeComponentCloseReport | undefined
      this.input.installed.push(Object.freeze({
        id: this.input.provider.id,
        close: (deadline?: ProviderCleanupDeadline) => {
          if (report !== undefined) return report
          this.cleanupDeadline = deadline
          // Prevent recursive disposal while user cleanup is executing.
          report = closeRow(this.reportId)
          try { dispose() } catch {
            report = this.failureCleanup ?? closeRow(this.reportId, 'CAPABILITY_CLEANUP_FAILED')
          }
          return report
        },
      }))
      checkPreflightAbort(this.input.signal)
    } catch (error: unknown) {
      this.failActivation(error)
    }
  }

  private failActivation(error: unknown): never {
    const aborted = this.failureWasAbort ?? this.input.signal?.aborted === true
    if (aborted) this.setupOperation.abort(); else this.setupOperation.fail(error)
    const cleanupRows: RuntimeComponentCloseReport[] = []
    if (this.failureCleanup !== undefined) cleanupRows.push(this.failureCleanup)
    const deadline = this.input.deadlines?.rollback()
    for (const registration of [...this.input.installed].reverse()) cleanupRows.push(registration.close(deadline))
    throw new AgentRuntimeConstructionError({
      failureCode: aborted ? 'CAPABILITY_STARTUP_ABORTED' : this.failureCode,
      stage: 'provider-setup',
      reason: activationFailureReason(aborted, this.failureCode),
      component: { kind: 'provider-plugin', id: this.reportId }, cleanup: cleanupRows,
    })
  }

  private setup(upstream: ModelProviderRegistrar) {
    const setupOnly = (): void => {
      if (this.phase !== 'setup') throw lifecycleError()
      checkPreflightAbort(this.input.signal)
    }
    const disposeOnly = (): void => {
      if (this.phase !== 'setup' && this.phase !== 'cleanup' && this.phase !== 'closed') throw lifecycleError()
    }
    const { registrar, registrations } = createRegistrar(this.input.provider, upstream, {
      logger: this.input.logger, setupOnly, disposeOnly,
    })
    try {
      const result = this.input.provider.setup(registrar)
      this.phase = 'sealed'
      this.cleanup = typeof result === 'function' ? result : undefined
      if (asynchronous(result)) {
        this.failureCode = 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
        throw new Error('Asynchronous provider setup is unsupported')
      }
      if (result !== undefined && typeof result !== 'function') throw new Error('Invalid provider setup result')
      checkPreflightAbort(this.input.signal)
      validateRegisteredRoutes(this.input.provider, registrations)
      this.setupOperation.success()
      return () => {
        const row = this.finishCleanup()
        if (row.status !== 'closed') throw new Error('Provider cleanup did not complete')
      }
    } catch (error) {
      this.failSetup(error)
    } finally {
      if (this.phase === 'setup') this.phase = 'sealed'
    }
  }

  private failSetup(error: unknown): never {
    if (this.input.signal?.aborted === true) this.setupOperation.abort(); else this.setupOperation.fail(error)
    this.failureWasAbort = this.input.signal?.aborted === true
    this.phase = 'sealed'
    if (this.cleanup !== undefined) this.failureCleanup = this.finishCleanup()
    throw error
  }

  private finishCleanup(): RuntimeComponentCloseReport {
    if (this.cleaned) return this.failureCleanup ?? closeRow(this.reportId)
    if (!this.committed) this.failureWasAbort ??= this.input.signal?.aborted === true
    this.cleaned = true
    this.phase = 'cleanup'
    let code: CleanupCode | undefined
    try {
      code = this.performCleanup()
    } catch { code = 'CAPABILITY_CLEANUP_FAILED' }
    finally { this.phase = 'closed' }
    const row = closeRow(this.reportId, code)
    this.failureCleanup = row
    return row
  }

  private performCleanup(): CleanupCode | undefined {
    if (!this.committed) this.cleanupDeadline ??= this.input.deadlines?.rollback()
    const cleanup = this.cleanup
    if (cleanup !== undefined) {
      if (this.cleanupDeadline !== undefined
        && this.cleanupDeadline.now() >= this.cleanupDeadline.at) return 'CAPABILITY_CLEANUP_TIMEOUT'
      else if (asynchronous(cleanup())) return 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'
    }
    return undefined
  }
}

function createRegistrar(
  provider: CapturedProvider, upstream: ModelProviderRegistrar,
  guards: { logger: SdkLogger; setupOnly: () => void; disposeOnly: () => void },
) {
  const { logger, setupOnly, disposeOnly } = guards
  const registrations: RouteRegistration[] = []
  const routesFor = (input: unknown, current?: RouteRegistration): readonly string[] => {
    setupOnly()
    const routes = arrayData(input, COMPOSITION_LIMITS.routesPerProvider)
      .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
    const occupied = new Set(registrations.filter(row => row.active
      && row !== current).flatMap(row => row.routes))
    for (const route of routes) {
      if (!provider.routes.includes(route) || occupied.has(route)) throw claimError()
      occupied.add(route)
    }
    return Object.freeze(routes)
  }
  const registrar: RuntimeProviderRegistrar = Object.freeze({
    logger,
    registerAdapter(input: readonly string[], adapter: ModelAdapter) {
      const routes = routesFor(input)
      if (routes.length === 0) throw claimError()
      const handle = upstream.registerAdapter(routes, adapter)
      const row: RouteRegistration = { active: true, routes }
      registrations.push(row)
      const release = (() => {
        disposeOnly()
        if (!row.active) return
        handle()
        row.active = false
      }) as AdapterRegistrationHandle
      release.replace = next => {
        if (!row.active) throw lifecycleError()
        const replacement = routesFor(next, row)
        handle.replace(replacement)
        row.routes = replacement
      }
      return Object.freeze(release)
    },
    use(middleware: StreamMiddleware) {
      setupOnly()
      const release = upstream.use(middleware)
      let released = false
      return () => {
        disposeOnly()
        if (released) return
        released = true
        release()
      }
    },
  })
  return { registrar, registrations }
}

function cleanupStatus(code: CleanupCode | undefined): RuntimeComponentCloseReport['status'] {
  if (code === undefined) return 'closed'
  return code === 'CAPABILITY_CLEANUP_TIMEOUT' ? 'timed-out' : 'failed'
}

function activationFailureReason(aborted: boolean, code: RuntimeConstructionFailureCode) {
  if (aborted) return 'aborted' as const
  return code === 'CAPABILITY_STARTUP_TIMEOUT' ? 'timed-out' as const : 'failed' as const
}

function validateRegisteredRoutes(provider: CapturedProvider, registrations: readonly RouteRegistration[]): void {
  const routes = registrations.filter(row => row.active).flatMap(row => row.routes)
  if (routes.length !== provider.routes.length || provider.routes.some(route => !routes.includes(route))) {
    throw claimError()
  }
}
