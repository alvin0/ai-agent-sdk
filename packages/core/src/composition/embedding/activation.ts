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
export function activateEmbeddingProviders(
  registry: EmbeddingRegistry,
  providers: readonly CapturedEmbeddingProvider[],
  logger: SdkLogger,
  signal?: AbortSignal,
  deadlines?: ProviderActivationDeadlines,
  shared?: SharedProviderActivation,
): readonly ProviderRegistration[] {
  checkPreflightAbort(signal)
  const installed: ProviderRegistration[] = shared?.installed ?? []
  const idOffset = installed.length
  for (const [index, provider] of providers.entries()) {
    const setupOperation = beginCoreCapabilityOperation(
      logger.child({ providerIndex: idOffset + index }), 'core-provider', 'setup',
    )
    let phase: 'setup' | 'sealed' | 'cleanup' | 'closed' = 'setup'
    let failureCode: RuntimeConstructionFailureCode = 'CAPABILITY_STARTUP_FAILED'
    let failureCleanup: RuntimeComponentCloseReport | undefined
    let cleanup: (() => void) | undefined
    let cleaned = false
    let committed = false
    let cleanupDeadline: ProviderCleanupDeadline | undefined
    let failureWasAbort: boolean | undefined
    const registrations: RouteRegistration[] = []
    // Support reports do not echo an arbitrary user-supplied identity.
    const reportId = `provider-${idOffset + index}`
    /** Topology leaves the registry BEFORE user cleanup runs, as it does for generation. */
    const release = (): void => {
      for (const row of [...registrations].reverse()) {
        if (!row.active) continue
        row.active = false
        try { row.handle() } catch { /* a broken disposer must not strand the others */ }
      }
    }
    const finishCleanup = (): RuntimeComponentCloseReport => {
      if (cleaned) return failureCleanup ?? closeRow(reportId)
      if (!committed) failureWasAbort ??= signal?.aborted === true
      cleaned = true
      phase = 'cleanup'
      let code: CleanupCode | undefined
      try {
        if (!committed) cleanupDeadline ??= deadlines?.rollback()
        const expired = cleanupDeadline !== undefined && cleanupDeadline.now() >= cleanupDeadline.at
        // An expired budget still removes topology; only the plugin's own
        // disposer is skipped, matching the generation contract exactly.
        if (expired) code = 'CAPABILITY_CLEANUP_TIMEOUT'
        release()
        if (cleanup !== undefined && !expired && asynchronous(cleanup())) {
          code = 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'
        }
      } catch { code = 'CAPABILITY_CLEANUP_FAILED' }
      finally { phase = 'closed' }
      const row = closeRow(reportId, code)
      failureCleanup = row
      return row
    }
    try {
      checkPreflightAbort(signal)
      if (deadlines !== undefined && deadlines.startup.now() >= deadlines.startup.at) {
        failureCode = 'CAPABILITY_STARTUP_TIMEOUT'
        throw new Error('Provider startup deadline exhausted')
      }
      const setupOnly = (): void => {
        if (phase !== 'setup') throw providerLifecycleError()
        checkPreflightAbort(signal)
      }
      const disposeOnly = (): void => {
        if (phase !== 'setup' && phase !== 'cleanup' && phase !== 'closed') throw providerLifecycleError()
      }
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
      try {
        const result = provider.setup(registrar)
        phase = 'sealed'
        cleanup = typeof result === 'function' ? result : undefined
        if (asynchronous(result)) {
          failureCode = 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
          throw new Error('Asynchronous provider setup is unsupported')
        }
        if (result !== undefined && typeof result !== 'function') throw new Error('Invalid provider setup result')
        checkPreflightAbort(signal)
        const claimed = new Set(registrations.filter(row => row.active).flatMap(row => row.routes))
        if (provider.routes.some(route => !claimed.has(route))) throw providerClaimError()
      } catch (error) {
        if (signal?.aborted === true) setupOperation.abort(); else setupOperation.fail(error)
        failureWasAbort = signal?.aborted === true
        phase = 'sealed'
        // Nothing else will release what this setup already put into the
        // registry: it never became a registration in `installed`.
        if (cleanup !== undefined || registrations.some(row => row.active)) failureCleanup = finishCleanup()
        throw error
      } finally {
        if (phase === 'setup') phase = 'sealed'
      }
      setupOperation.success()
      committed = true
      let report: RuntimeComponentCloseReport | undefined
      installed.push(Object.freeze({
        id: provider.id,
        close(deadline?: ProviderCleanupDeadline) {
          if (report !== undefined) return report
          cleanupDeadline = deadline
          report = finishCleanup()
          return report
        },
      }))
      checkPreflightAbort(signal)
    } catch (error: unknown) {
      const aborted = failureWasAbort ?? signal?.aborted === true
      if (aborted) setupOperation.abort(); else setupOperation.fail(error)
      const cleanupRows: RuntimeComponentCloseReport[] = []
      if (failureCleanup !== undefined) cleanupRows.push(failureCleanup)
      const deadline = deadlines?.rollback()
      for (const registration of [...installed].reverse()) cleanupRows.push(registration.close(deadline))
      throw new AgentRuntimeConstructionError({
        failureCode: aborted ? 'CAPABILITY_STARTUP_ABORTED' : failureCode,
        stage: 'provider-setup',
        reason: aborted ? 'aborted' : failureCode === 'CAPABILITY_STARTUP_TIMEOUT' ? 'timed-out' : 'failed',
        component: { kind: 'provider-plugin', id: reportId }, cleanup: cleanupRows,
      })
    }
  }
  return Object.freeze([...installed])
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
  activateProviders(input.registry, input.providers, input.logger, input.signal, input.deadlines, shared)
  return activateEmbeddingProviders(input.embeddingRegistry, input.embeddingProviders,
    input.logger, input.signal, input.deadlines, shared)
}
