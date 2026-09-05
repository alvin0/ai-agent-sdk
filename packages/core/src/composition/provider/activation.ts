import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { ModelAdapter } from '../../contract/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { AdapterRegistrationHandle, ModelProviderRegistrar, StreamMiddleware } from '../../plugin/provider-plugin.ts'
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

const lifecycleError = () => new AgentSdkError('Provider registration is outside setup or cleanup', 'PROVIDER_REGISTRAR_SEALED')
const claimError = () => new AgentSdkError('Provider registration must cover its declared routes exactly once', 'PROVIDER_CLAIMS_INVALID')

/** Reject and observe asynchronous returns without reading a then property a second time. */
function asynchronous(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  let then: unknown
  try { then = Reflect.get(value, 'then') } catch { return true }
  if (typeof then !== 'function') return false
  void new Promise((resolve, reject) => { Reflect.apply(then, value, [resolve, reject]) }).catch(() => undefined)
  return true
}

type CleanupCode = 'CAPABILITY_CLEANUP_FAILED' | 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED' | 'CAPABILITY_CLEANUP_TIMEOUT'

function closeRow(id: string, code?: CleanupCode): RuntimeComponentCloseReport {
  return Object.freeze({
    kind: 'provider-registration', id,
    status: code === undefined ? 'closed' : code === 'CAPABILITY_CLEANUP_TIMEOUT' ? 'timed-out' : 'failed',
    ...(code !== undefined ? { error: Object.freeze({
      code, stage: 'provider-cleanup', message: 'Provider cleanup did not complete synchronously',
    }) } : {}),
  })
}

/** Activate already-captured providers. The caller owns bus/exporter startup and the overall deadline. */
export function activateProviders(
  registry: ModelRegistry,
  providers: readonly CapturedProvider[],
  logger: SdkLogger,
  signal?: AbortSignal,
  deadlines?: ProviderActivationDeadlines,
): readonly ProviderRegistration[] {
  checkPreflightAbort(signal)
  const installed: ProviderRegistration[] = []
  for (const [index, provider] of providers.entries()) {
    const setupOperation = beginCoreCapabilityOperation(
      logger.child({ providerIndex: index }), 'core-provider', 'setup',
    )
    let phase: 'setup' | 'sealed' | 'cleanup' | 'closed' = 'setup'
    let failureCode: RuntimeConstructionFailureCode = 'CAPABILITY_STARTUP_FAILED'
    let failureCleanup: RuntimeComponentCloseReport | undefined
    let cleanup: (() => void) | undefined
    let cleaned = false
    let committed = false
    let cleanupDeadline: ProviderCleanupDeadline | undefined
    let failureWasAbort: boolean | undefined
    // Support reports do not echo an arbitrary user-supplied identity.
    const reportId = `provider-${index}`
    const finishCleanup = (): RuntimeComponentCloseReport => {
      if (cleaned) return failureCleanup ?? closeRow(reportId)
      if (!committed) failureWasAbort ??= signal?.aborted === true
      cleaned = true
      phase = 'cleanup'
      let code: CleanupCode | undefined
      try {
        if (!committed) cleanupDeadline ??= deadlines?.rollback()
        if (cleanup !== undefined) {
          if (cleanupDeadline !== undefined && cleanupDeadline.now() >= cleanupDeadline.at) code = 'CAPABILITY_CLEANUP_TIMEOUT'
          else if (asynchronous(cleanup())) code = 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'
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
      const dispose = registry.install({
        id: provider.id, displayName: provider.displayName, family: provider.family,
        setup(upstream) {
          const registrations: RouteRegistration[] = []
          const setupOnly = (): void => {
            if (phase !== 'setup') throw lifecycleError()
            checkPreflightAbort(signal)
          }
          const disposeOnly = (): void => {
            if (phase !== 'setup' && phase !== 'cleanup' && phase !== 'closed') throw lifecycleError()
          }
          const routesFor = (input: unknown, current?: RouteRegistration): readonly string[] => {
            setupOnly()
            const routes = arrayData(input, COMPOSITION_LIMITS.routesPerProvider)
              .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
            const occupied = new Set(registrations.filter(row => row.active && row !== current).flatMap(row => row.routes))
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
            const routes = registrations.filter(row => row.active).flatMap(row => row.routes)
            if (routes.length !== provider.routes.length || provider.routes.some(route => !routes.includes(route))) {
              throw claimError()
            }
            setupOperation.success()
            return () => {
              const row = finishCleanup()
              if (row.status !== 'closed') throw new Error('Provider cleanup did not complete')
            }
          } catch (error) {
            if (signal?.aborted === true) setupOperation.abort(); else setupOperation.fail(error)
            failureWasAbort = signal?.aborted === true
            phase = 'sealed'
            if (cleanup !== undefined) failureCleanup = finishCleanup()
            throw error
          } finally {
            if (phase === 'setup') phase = 'sealed'
          }
        },
      })
      committed = true
      let report: RuntimeComponentCloseReport | undefined
      installed.push(Object.freeze({
        id: provider.id,
        close(deadline?: ProviderCleanupDeadline) {
          if (report !== undefined) return report
          cleanupDeadline = deadline
          // Prevent recursive disposal while user cleanup is executing.
          report = closeRow(reportId)
          try { dispose() } catch { report = failureCleanup ?? closeRow(reportId, 'CAPABILITY_CLEANUP_FAILED') }
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
        stage: 'provider-setup', reason: aborted ? 'aborted' : failureCode === 'CAPABILITY_STARTUP_TIMEOUT' ? 'timed-out' : 'failed',
        component: { kind: 'provider-plugin', id: reportId }, cleanup: cleanupRows,
      })
    }
  }
  return Object.freeze(installed)
}
