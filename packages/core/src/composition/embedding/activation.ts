/**
 * Activation for the embedding plugin kind, sharing ONE rollback list with generation.
 *
 * The shape mirrors `activateProviders` on purpose — same phase machine, same
 * cleanup accounting, same `provider-N` report ids — because the two kinds must be
 * indistinguishable from the outside once startup either succeeded or unwound
 * (Requirement 11.7). What differs is only where a registration lands:
 * `EmbeddingRegistry` is itself the registrar, so there is no `install()`
 * transaction to borrow and this module releases the route handles it took.
 *
 * Rollback is not atomic per route — two kinds are two plugin objects and two
 * `setup()` calls. Two other layers make that safe: the whole-input preflight
 * rejects every route–operation conflict BEFORE any plugin is committed, and the
 * `installed[]` list swept here spans both kinds, so a failing embedding plugin
 * releases the generation registrations that went in before it.
 *
 * Both edge configurations are first-class, not special cases: a `providers` list
 * of only generation plugins never constructs an embedding registration
 * (Requirement 11.8), and a list of only embedding plugins activates, serves and
 * closes with an empty generation registry (Requirement 11.9).
 *
 * @module ai-agent-sdk/core/composition/embedding/activation
 */

import type { SdkLogger } from '../../logging/types.ts'
import type { AdapterRegistrationHandle } from '../../plugin/provider-plugin.ts'
import type { ModelRegistry } from '../../runtime/registry.ts'
import type { EmbeddingAdapter } from '../../embedding/adapter.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText } from '../common/data.ts'
import { AgentRuntimeConstructionError, checkPreflightAbort } from '../common/errors.ts'
import type { RuntimeComponentCloseReport, RuntimeConstructionFailureCode } from '../common/errors.ts'
import { beginCoreCapabilityOperation } from '../logging/capability.ts'
import {
  activateProviders, asynchronous, closeRow, providerClaimError, providerLifecycleError,
  type CleanupCode, type ProviderActivationDeadlines, type ProviderCleanupDeadline,
  type ProviderRegistration, type SharedProviderActivation,
} from '../provider/activation.ts'
import type { CapturedProvider } from '../provider/types.ts'
import type { CapturedEmbeddingProvider } from './preflight.ts'
import type { EmbeddingProviderRegistrar } from './plugin-types.ts'
import { EmbeddingRegistry } from './registry.ts'

/** What an embedding plugin's `setup()` receives, logger included. */
export interface RuntimeEmbeddingProviderRegistrar extends EmbeddingProviderRegistrar {
  readonly logger: SdkLogger
}

interface RouteRegistration {
  active: boolean
  routes: readonly string[]
  readonly handle: AdapterRegistrationHandle
}

/**
 * Activate already-captured embedding plugins against one runtime registry.
 *
 * @param registry - the runtime's embedding registry, never the `ModelRegistry`.
 * @param providers - plugins whose `setup` was captured by the preflight.
 * @param shared - the cross-kind rollback list; omit for a private one.
 * @returns every registration in the shared list, this activation's included.
 * @throws AgentRuntimeConstructionError after rolling back the WHOLE shared list.
 */
interface EmbeddingActivationOptions {
  readonly signal?: AbortSignal | undefined
  readonly deadlines?: ProviderActivationDeadlines | undefined
  readonly shared?: SharedProviderActivation | undefined
}

export function activateEmbeddingProviders(
  registry: EmbeddingRegistry, providers: readonly CapturedEmbeddingProvider[], logger: SdkLogger,
  options: EmbeddingActivationOptions = {},
): readonly ProviderRegistration[] {
  const { signal, deadlines, shared } = options
  checkPreflightAbort(signal)
  const installed: ProviderRegistration[] = shared?.installed ?? []
  const idOffset = installed.length
  for (const [index, provider] of providers.entries()) {
    new EmbeddingProviderActivation({
      registry, provider, logger, signal, deadlines, installed, index: idOffset + index,
    }).install()
  }
  return Object.freeze([...installed])
}

interface ActivationInput {
  registry: EmbeddingRegistry
  provider: CapturedEmbeddingProvider
  logger: SdkLogger
  signal: AbortSignal | undefined
  deadlines: ProviderActivationDeadlines | undefined
  installed: ProviderRegistration[]
  index: number
}

class EmbeddingProviderActivation {
  private phase: 'setup' | 'sealed' | 'cleanup' | 'closed' = 'setup'
  private failureCode: RuntimeConstructionFailureCode = 'CAPABILITY_STARTUP_FAILED'
  private failureCleanup: RuntimeComponentCloseReport | undefined
  private cleanup: (() => void) | undefined
  private cleaned = false
  private committed = false
  private cleanupDeadline: ProviderCleanupDeadline | undefined
  private failureWasAbort: boolean | undefined
  private readonly registrations: RouteRegistration[] = []
  private readonly reportId: string
  private readonly setupOperation: ReturnType<typeof beginCoreCapabilityOperation>
  private readonly input: ActivationInput

  constructor(input: ActivationInput) {
    this.input = input
    this.setupOperation = beginCoreCapabilityOperation(
      input.logger.child({ providerIndex: input.index }), 'core-provider', 'setup',
    )
    this.reportId = `provider-${input.index}`
  }

  install(): void {
    const { provider, signal, deadlines, installed } = this.input
    try {
      checkPreflightAbort(signal)
      if (deadlines !== undefined && deadlines.startup.now() >= deadlines.startup.at) {
        this.failureCode = 'CAPABILITY_STARTUP_TIMEOUT'
        throw new Error('Provider startup deadline exhausted')
      }
      this.setup()
      this.setupOperation.success()
      this.committed = true
      let report: RuntimeComponentCloseReport | undefined
      installed.push(Object.freeze({
        id: provider.id,
        close: (deadline?: ProviderCleanupDeadline) => {
          if (report !== undefined) return report
          this.cleanupDeadline = deadline
          report = this.finishCleanup()
          return report
        },
      }))
      checkPreflightAbort(signal)
    } catch (error: unknown) {
      this.failActivation(error)
    }
  }

  private setup(): void {
    const { provider, registry, logger, signal } = this.input
    const setupOnly = (): void => {
      if (this.phase !== 'setup') throw providerLifecycleError()
      checkPreflightAbort(signal)
    }
    const disposeOnly = (): void => {
      if (this.phase !== 'setup' && this.phase !== 'cleanup' && this.phase !== 'closed') {
        throw providerLifecycleError()
      }
    }
    const registrar = createEmbeddingRegistrar(provider, registry, this.registrations, {
      logger, setupOnly, disposeOnly,
    })
    try {
      const result = provider.setup(registrar)
      this.phase = 'sealed'
      this.cleanup = typeof result === 'function' ? result : undefined
      if (asynchronous(result)) {
        this.failureCode = 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
        throw new Error('Asynchronous provider setup is unsupported')
      }
      if (result !== undefined && typeof result !== 'function') throw new Error('Invalid provider setup result')
      checkPreflightAbort(signal)
      const claimed = new Set(this.registrations.filter(row => row.active).flatMap(row => row.routes))
      if (provider.routes.some(route => !claimed.has(route))) throw providerClaimError()
    } catch (error) {
      this.failSetup(error)
    } finally {
      if (this.phase === 'setup') this.phase = 'sealed'
    }
  }

  private failSetup(error: unknown): never {
    const { signal } = this.input
    if (signal?.aborted === true) this.setupOperation.abort(); else this.setupOperation.fail(error)
    this.failureWasAbort = signal?.aborted === true
    this.phase = 'sealed'
    // Nothing else will release what this setup already put into the
    // registry: it never became a registration in `installed`.
    if (this.cleanup !== undefined || this.registrations.some(row => row.active)) {
      this.failureCleanup = this.finishCleanup()
    }
    throw error
  }

  private failActivation(error: unknown): never {
    const { signal, deadlines, installed } = this.input
    const aborted = this.failureWasAbort ?? signal?.aborted === true
    if (aborted) this.setupOperation.abort(); else this.setupOperation.fail(error)
    const cleanupRows: RuntimeComponentCloseReport[] = []
    if (this.failureCleanup !== undefined) cleanupRows.push(this.failureCleanup)
    const deadline = deadlines?.rollback()
    for (const registration of [...installed].reverse()) cleanupRows.push(registration.close(deadline))
    throw new AgentRuntimeConstructionError({
      failureCode: aborted ? 'CAPABILITY_STARTUP_ABORTED' : this.failureCode,
      stage: 'provider-setup',
      reason: activationFailureReason(aborted, this.failureCode),
      component: { kind: 'provider-plugin', id: this.reportId }, cleanup: cleanupRows,
    })
  }

  private release(): void {
    for (const row of [...this.registrations].reverse()) {
      if (!row.active) continue
      row.active = false
      try { row.handle() } catch { /* a broken disposer must not strand the others */ }
    }
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
    const { deadlines } = this.input
    if (!this.committed) this.cleanupDeadline ??= deadlines?.rollback()
    const cleanup = this.cleanup
    const expired = this.cleanupDeadline !== undefined && this.cleanupDeadline.now() >= this.cleanupDeadline.at
    // An expired budget still removes topology; only the plugin's own
    // disposer is skipped, matching the generation contract exactly.
    let code: CleanupCode | undefined
    if (expired) code = 'CAPABILITY_CLEANUP_TIMEOUT'
    this.release()
    if (cleanup !== undefined && !expired && asynchronous(cleanup())) {
      code = 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'
    }
    return code
  }
}

function createEmbeddingRegistrar(
  provider: CapturedEmbeddingProvider, registry: EmbeddingRegistry, registrations: RouteRegistration[],
  guards: { logger: SdkLogger; setupOnly: () => void; disposeOnly: () => void },
): RuntimeEmbeddingProviderRegistrar {
  const { logger, setupOnly, disposeOnly } = guards
  /**
   * Route claims are checked here, not in the registry: the registry owns
   * cross-plugin vacancy, this owns "inside what this plugin predeclared".
   */
  const routesFor = (input: unknown): readonly string[] => {
    setupOnly()
    const routes = arrayData(input, COMPOSITION_LIMITS.routesPerProvider)
      .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
    if (routes.length === 0 || new Set(routes).size !== routes.length) throw providerClaimError()
    for (const route of routes) if (!provider.routes.includes(route)) throw providerClaimError()
    return Object.freeze(routes)
  }
  const registrar: RuntimeEmbeddingProviderRegistrar = Object.freeze({
    logger,
    registerEmbeddingAdapter(
      input: readonly string[], adapter: EmbeddingAdapter, models?: readonly string[],
    ) {
      const routes = routesFor(input)
      // Model-scoped and route-wide claims coexist by design, so same-route
      // duplication is the registry's call, not this layer's.
      const handle = registry.registerEmbeddingAdapter(routes, adapter, models)
      const row: RouteRegistration = { active: true, routes, handle }
      registrations.push(row)
      const dispose = (() => {
        disposeOnly()
        if (!row.active) return
        handle()
        row.active = false
      }) as AdapterRegistrationHandle
      dispose.replace = next => {
        if (!row.active) throw providerLifecycleError()
        const replacement = routesFor(next)
        handle.replace(replacement)
        row.routes = replacement
      }
      return Object.freeze(dispose)
    },
  })
  return registrar
}

function activationFailureReason(aborted: boolean, code: RuntimeConstructionFailureCode) {
  if (aborted) return 'aborted' as const
  return code === 'CAPABILITY_STARTUP_TIMEOUT' ? 'timed-out' as const : 'failed' as const
}

/** Both halves of one validated `providers` list, ready to activate. */
export interface RuntimeProviderActivationInput {
  readonly registry: ModelRegistry
  readonly embeddingRegistry: EmbeddingRegistry
  readonly providers: readonly CapturedProvider[]
  readonly embeddingProviders: readonly CapturedEmbeddingProvider[]
  readonly logger: SdkLogger
  readonly signal?: AbortSignal
  readonly deadlines?: ProviderActivationDeadlines
}

/**
 * Activate generation first, then embedding, over ONE rollback list.
 *
 * Order matters only for reporting: whichever step fails, the failure unwinds the
 * complete list, so the runtime either owns every registration or none.
 *
 * @returns the combined registration list, in installation order.
 */
export function activateRuntimeProviders(
  input: RuntimeProviderActivationInput,
): readonly ProviderRegistration[] {
  const shared: SharedProviderActivation = { installed: [] }
  activateProviders(input.registry, input.providers, input.logger, {
    signal: input.signal, deadlines: input.deadlines, shared,
  })
  return activateEmbeddingProviders(input.embeddingRegistry, input.embeddingProviders,
    input.logger, { signal: input.signal, deadlines: input.deadlines, shared })
}
