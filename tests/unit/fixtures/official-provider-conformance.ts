import {
  ModelAdapter,
  withRetry,
  type GenerateOptions,
  type ModelCatalogOptions,
  type ModelCatalogSnapshot,
  type ModelInfo,
  type ModelInvocationContext,
  type PreparedAdapterCall,
  type ProviderInfo,
  type ResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import { defineModelProviderPlugin } from '@ai-agent-sdk/core/provider'
import type {
  ProviderConformanceCase,
  ProviderConformanceCaseInput,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderConformanceScenario,
} from '@ai-agent-sdk/testkit'

export interface OfficialHttpAdapterInput {
  readonly fetch: typeof globalThis.fetch
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly maxSseEvents: number
}

export interface OfficialProviderConformanceConfig {
  readonly family: string
  readonly model: string
  readonly completeFrames: readonly string[]
  readonly missingUsageFrames: readonly string[]
  readonly malformedUsageFrames: readonly string[]
  createAdapter(input: OfficialHttpAdapterInput): ModelAdapter
}

interface MutableControl {
  setupCalls: number
  cleanupCalls: number
  dispatchCalls: number
  entered: Promise<void>
  enter(): void
}

/** Drive an official HTTP adapter through the public third-party conformance contract. */
export function officialProviderConformanceFixture(
  config: OfficialProviderConformanceConfig,
): ProviderConformanceFixture {
  return Object.freeze({
    create(input: ProviderConformanceCaseInput): ProviderConformanceCase {
      const control = mutableControl()
      const fetch = scriptedFetch(input.scenario, input.privateSentinel, config, control)
      const configured = config.createAdapter({
        fetch,
        models: input.scenario === 'catalog-empty' ? [] : [{ id: config.model, name: config.model }],
        maxSseEvents: input.scenario === 'stream-bound-failure' ? 1 : 100,
      })
      const adapter = input.scenario === 'catalog-failure'
        ? new CatalogFailureAdapter(configured)
        : configured
      const active = input.scenario === 'retry-success' || input.scenario === 'retry-exhaustion'
        ? withRetry(adapter, { policy: { mode: 'normal', maxRetries: 1,
          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
        : adapter
      const plugin = defineModelProviderPlugin({
        id: input.id,
        family: config.family,
        displayName: `${config.family} conformance`,
        routes: [input.route],
        setup(registrar) {
          control.setupCalls++
          const remove = registrar.registerAdapter(active)
          return () => {
            remove()
            control.cleanupCalls++
            if (input.scenario === 'cleanup-failure') throw new Error(input.privateSentinel)
            return undefined
          }
        },
      })
      return Object.freeze({
        plugin,
        route: input.route,
        model: config.model,
        expectedAttempts: 2,
        expectedTotalTokens: 5,
        ...(input.scenario === 'stream-bound-failure'
          ? { expectedFailureCode: 'HTTP_SSE_LIMIT_EXCEEDED' }
          : {}),
        control: Object.freeze({
          snapshot: (): ProviderConformanceControlSnapshot => Object.freeze({
            setupCalls: control.setupCalls,
            cleanupCalls: control.cleanupCalls,
            dispatchCalls: control.dispatchCalls,
          }),
          waitForDispatch: () => control.entered,
        }),
      })
    },
  })
}

class CatalogFailureAdapter extends ModelAdapter {
  constructor(private readonly inner: ModelAdapter) { super() }
  override providerInfo(provider: string): ProviderInfo { return this.inner.providerInfo(provider) }
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.inner.providerRetryPolicy(provider)
  }
  override listModels(_provider: string, _signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    return Promise.reject(new Error('private injected catalog failure'))
  }
  override modelCatalog(provider: string, options?: ModelCatalogOptions): Promise<ModelCatalogSnapshot> {
    return super.modelCatalog(provider, options)
  }
  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return this.inner.resolveModel(provider, model, signal)
  }
  override prepareCall(
    provider: string, model: string, signal?: AbortSignal, context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    return this.inner.prepareCall(provider, model, signal, context)
  }
  override stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.inner.stream(options, context)
  }
}

function scriptedFetch(
  scenario: ProviderConformanceScenario,
  privateSentinel: string,
  config: OfficialProviderConformanceConfig,
  control: MutableControl,
): typeof globalThis.fetch {
  return async (_input, init) => {
    control.dispatchCalls++
    control.enter()
    if (scenario === 'abort-in-flight') {
      await aborted(init?.signal ?? undefined)
      throw new DOMException('request aborted', 'AbortError')
    }
    if (scenario === 'retry-exhaustion'
      || (scenario === 'retry-success' && control.dispatchCalls === 1)) {
      return new Response(`provider failure ${privateSentinel}`, { status: 500 })
    }
    if (scenario === 'stream-bound-failure') {
      return sseResponse(['data: {}', `data: ${JSON.stringify({ privateSentinel })}`])
    }
    if (scenario === 'missing-usage') return sseResponse(config.missingUsageFrames)
    if (scenario === 'malformed-usage') return sseResponse(config.malformedUsageFrames)
    return sseResponse(config.completeFrames)
  }
}

function mutableControl(): MutableControl {
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { setupCalls: 0, cleanupCalls: 0, dispatchCalls: 0, entered, enter }
}

function sseResponse(frames: readonly string[]): Response {
  const encoded = new TextEncoder().encode(`${frames.join('\n\n')}\n\n`)
  return new Response(encoded, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function aborted(signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
}
