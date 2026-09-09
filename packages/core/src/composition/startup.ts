import type { SdkLogger } from '../logging/types.ts'
import { RuntimeResources } from '../platform/resources.ts'
import { timeoutValue } from '../platform/config.ts'
import type { ModelRegistry } from '../runtime/registry.ts'
import { AgentRuntimeConstructionError, checkPreflightAbort } from './common/errors.ts'
import { RuntimeExporters } from './exporter/lifecycle.ts'
import { activateProviders, type ProviderRegistration } from './provider/activation.ts'
import type { RuntimeCapabilityPlan } from './preflight.ts'

export interface CapabilityStartupOptions {
  readonly startupTimeoutMs: number
  readonly rollbackTimeoutMs: number
  readonly signal?: AbortSignal
}

/** Transactional inner startup; the composition root supplies its canonical registry, logger and resources. */
export async function activateRuntimeCapabilities(
  plan: RuntimeCapabilityPlan, registry: ModelRegistry, logger: SdkLogger,
  resources: RuntimeResources, options: CapabilityStartupOptions,
): Promise<{ readonly providers: readonly ProviderRegistration[]; readonly exporters: RuntimeExporters }> {
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
  let providers: readonly ProviderRegistration[] = []
  try {
    providers = activateProviders(registry, plan.providers, logger, signal, {
      startup: { at: deadlineAt, now: () => resources.platform.monotonicNow() }, rollback: rollbackDeadline,
    })
    await exporters.ready(deadlineAt, signal)
    if (signal?.aborted) throw new AgentRuntimeConstructionError({
      failureCode: 'CAPABILITY_STARTUP_ABORTED', stage: 'activation', reason: 'aborted',
    })
    if (resources.platform.monotonicNow() >= deadlineAt) throw new AgentRuntimeConstructionError({
      failureCode: 'CAPABILITY_STARTUP_TIMEOUT', stage: 'activation', reason: 'timed-out',
    })
    return Object.freeze({ providers, exporters })
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
      ...(failure.conflict === undefined ? {} : { conflict: failure.conflict }), cleanup,
    })
  }
}
