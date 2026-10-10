import type { ModelAdapter } from '../contract/adapter.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type { RuntimeDefaults } from '../contract/model-info.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import type { StreamMiddleware } from '../plugin/provider-plugin.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import { streamAdapter, type PreparedDispatch, type RuntimeAdapterRegistration } from './model-stream.ts'

interface RegistryStreamHost {
  readonly chain: readonly StreamMiddleware[]
  readonly maxCatalogBytes: number
  readonly defaults: RuntimeDefaults
  readonly prepared: PreparedDispatch | undefined
  registration(provider: string): RuntimeAdapterRegistration
  registeredAdapter(provider: string): ModelAdapter | undefined
}

/**
 * Compose installed middleware around the adapter boundary.
 *
 * Composition is deferred to the first iteration rather than done eagerly, so
 * that `stream()` ALWAYS returns an iterable and every failure — including a
 * middleware that throws synchronously — surfaces on the same path. Composing
 * eagerly would give callers two different error channels for the same class of
 * fault, and they would inevitably handle only one.
 *
 * The middleware list is snapshotted here so that installing or removing
 * middleware mid-stream cannot change the chain of a call already in flight.
 */
export function createRegistryStream(
  options: GenerateOptions, context: ModelInvocationContext, onDispatch: () => void, host: RegistryStreamHost,
): AsyncIterable<StreamChunk> {
  const chain = host.chain
  const run = (): AsyncIterable<StreamChunk> => {
    let next = (): AsyncIterable<StreamChunk> => streamAdapter({
      options, context, onDispatch, maxCatalogBytes: host.maxCatalogBytes, defaults: host.defaults,
      registration: host.registration,
      registeredAdapter: host.registeredAdapter,
      ...(host.prepared === undefined ? {} : { prepared: host.prepared }),
    })
    for (let index = chain.length - 1; index >= 0; index--) {
      const middleware = chain[index]
      if (middleware === undefined) continue
      const inner = next
      next = () => middleware(options, inner, context)
    }
    return next()
  }
  return {
    async * [Symbol.asyncIterator]() {
      yield* run()
    },
  }
}
