import { vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { createObservability } from '../../../packages/core/src/observability/bus.ts'
import type { Observability } from '../../../packages/core/src/observability/types.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { preflightRuntimeCapabilities } from '../../../packages/core/src/composition/preflight.ts'
import { activateRuntimeCapabilities } from '../../../packages/core/src/composition/startup.ts'
import type { ObservationExporterPlugin, RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function exporter(id = 'test-exporter'): ObservationExporterPlugin {
  return {
    kind: 'observation-exporter', apiVersion: 1, id, supportedBoundaries: ['none', 'local-durable'],
    ready: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined),
    export: vi.fn(async batch => ({ batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] })),
  }
}

export function registration(
  value = exporter(), ownership: 'owned' | 'borrowed' = 'owned',
): RuntimeObservationExporterRegistration {
  return { exporter: value, ownership, requirement: 'best-effort', boundary: 'none' }
}

class Adapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

export function provider(id = 'provider', cleanup: () => void = vi.fn(() => undefined)): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id, displayName: id, routes: [id],
    setup: vi.fn((registrar: import('../../../packages/core/src/plugin/provider-plugin.ts').ModelProviderRegistrar) => {
      registrar.registerAdapter([id], new Adapter())
      return cleanup
    }),
  }
}

export function startupFixture(registrations: unknown, providers: unknown = [provider()], signal?: AbortSignal): {
  readonly registry: ModelRegistry
  readonly resources: RuntimeResources
  readonly bus: Observability
  start(): ReturnType<typeof activateRuntimeCapabilities>
} {
  const plan = preflightRuntimeCapabilities(providers, registrations, undefined, signal)
  const registry = new ModelRegistry()
  const resources = new RuntimeResources(createRuntimePlatform())
  const bus = createObservability()
  return {
    registry, resources, bus,
    start: () => activateRuntimeCapabilities(plan, registry, bus.logger(), resources, {
      startupTimeoutMs: 20, rollbackTimeoutMs: 30, ...(signal === undefined ? {} : { signal }),
    }),
  }
}
