import type { SdkLogger } from '../logging/types.ts'
import { RuntimeResources } from '../platform/resources.ts'
import { timeoutValue } from '../platform/config.ts'
import type { ModelRegistry } from '../runtime/registry.ts'
import { AgentRuntimeConstructionError, checkPreflightAbort } from './common/errors.ts'
import { RuntimeExporters } from './exporter/lifecycle.ts'
import { activateRuntimeProviders } from './embedding/activation.ts'
import { EmbeddingRegistry } from './embedding/registry.ts'
import type { ProviderRegistration } from './provider/activation.ts'
import type { RuntimeCapabilityPlan } from './preflight.ts'

export interface CapabilityStartupOptions {
  readonly startupTimeoutMs: number
  readonly rollbackTimeoutMs: number
  readonly signal?: AbortSignal
}

export interface ActivatedRuntimeCapabilities {
  /** Generation AND embedding registrations, in installation order (Requirement 11.7). */
  readonly providers: readonly ProviderRegistration[]
  /** Owned here so it exists even when no embedding plugin was supplied. */
  readonly embeddingRegistry: EmbeddingRegistry
  readonly exporters: RuntimeExporters
}

/** Transactional inner startup; the composition root supplies its canonical registry, logger and resources. */
export async function activateRuntimeCapabilities(
  plan: RuntimeCapabilityPlan, registry: ModelRegistry, logger: SdkLogger,
  resources: RuntimeResources, options: CapabilityStartupOptions,
): Promise<ActivatedRuntimeCapabilities> {
  const startupTimeoutMs = timeoutValue(options.startupTimeoutMs)
  const rollbackTimeoutMs = timeoutValue(options.rollbackTimeoutMs)
  const signal = options.signal
  checkPreflightAbort(signal)
  const deadlineAt = resources.platform.monotonicNow() + startupTimeoutMs
  let rollbackDeadlineAt: number | undefined
  const rollbackDeadline = () => {
    rollbackDeadlineAt ??= resources.platform.monotonicNow() + rollbackTimeoutMs
    return { at: rollbackDeadlineAt, now: () => resources.platform.monotonicNow() }
  }
  const exporters = new RuntimeExporters(plan.exporters, resources)
  const embeddingRegistry = new EmbeddingRegistry()
  let providers: readonly ProviderRegistration[] = []
  try {
    providers = activateRuntimeProviders({
      registry, embeddingRegistry, providers: plan.providers,
      embeddingProviders: plan.embeddingProviders, logger,
      ...(signal === undefined ? {} : { signal }),
      deadlines: {
        startup: { at: deadlineAt, now: () => resources.platform.monotonicNow() }, rollback: rollbackDeadline,
      },
    })
    await exporters.ready(deadlineAt, signal)
    if (signal?.aborted) throw new AgentRuntimeConstructionError({
      failureCode: 'CAPABILITY_STARTUP_ABORTED', stage: 'activation', reason: 'aborted',
    })
    if (resources.platform.monotonicNow() >= deadlineAt) throw new AgentRuntimeConstructionError({
      failureCode: 'CAPABILITY_STARTUP_TIMEOUT', stage: 'activation', reason: 'timed-out',
    })
    return Object.freeze({ providers, embeddingRegistry, exporters })
  } catch (error) {
    // Capture the primary classification before cleanup can abort the caller or throw.
    const failure = error instanceof AgentRuntimeConstructionError ? error : new AgentRuntimeConstructionError({
      failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'activation', reason: 'failed',
    })
    const deadline = rollbackDeadline()
    const cleanup = [...failure.cleanup, ...[...providers].reverse().map(provider => provider.close(deadline)),
      ...await exporters.close(deadline.at)]
    throw new AgentRuntimeConstructionError({
      failureCode: failure.failureCode, stage: failure.stage, reason: failure.reason,
      ...(failure.component === undefined ? {} : { component: failure.component }),
      ...(failure.conflict === undefined ? {} : { conflict: failure.conflict }),
      ...(failure.aggregate.length === 0 ? {} : { aggregate: failure.aggregate }), cleanup,
    })
  }
}
