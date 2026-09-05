import {
  MODEL_ERROR_CODES,
  ModelAdapter,
  ModelError,
  withRetry,
} from '@ai-agent-sdk/core'
import { defineModelProviderPlugin } from '@ai-agent-sdk/core/provider'

class FixtureAdapter extends ModelAdapter {
  constructor(scenario, state, privateSentinel) {
    super()
    this.scenario = scenario
    this.state = state
    this.privateSentinel = privateSentinel
  }

  listModels(provider) {
    if (this.scenario === 'catalog-failure') return Promise.reject(new Error('catalog fixture failure'))
    if (this.scenario === 'catalog-empty') return Promise.resolve([])
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture model' }])
  }

  async *stream(options, context) {
    context?.declareProviderAttemptAccounting?.()
    const attempt = await context?.startProviderAttempt?.({
      provider: options.provider, model: options.model,
      method: 'POST', origin: 'https://conformance.invalid',
    }, options.signal)
    this.state.dispatchCalls++
    this.state.enter()
    if (this.scenario === 'stream-bound-failure') {
      attempt?.end({ status: 'error', dispatchState: 'sent',
        error: { type: 'ModelError', message: 'provider stream exceeded configured bound',
          code: 'FIXTURE_STREAM_LIMIT_EXCEEDED' } })
      throw new ModelError('provider stream exceeded configured bound', 'FIXTURE_STREAM_LIMIT_EXCEEDED', {
        cause: new Error(this.privateSentinel),
      })
    }
    if (this.scenario === 'abort-in-flight') {
      try {
        await new Promise((_resolve, reject) => {
          if (options.signal?.aborted) { reject(options.signal.reason); return }
          options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
      } catch (error) {
        attempt?.end({ status: 'aborted', dispatchState: 'unknown' })
        throw new ModelError('conformance request aborted', MODEL_ERROR_CODES.ABORTED, { cause: error })
      }
    }
    const retryFailure = this.scenario === 'retry-exhaustion'
      || (this.scenario === 'retry-success' && this.state.dispatchCalls === 1)
    if (retryFailure) {
      attempt?.end({ status: 'error', dispatchState: 'sent',
        error: { type: 'ModelError', message: 'conformance transient failure', code: MODEL_ERROR_CODES.SERVER } })
      throw new ModelError('conformance transient failure', MODEL_ERROR_CODES.SERVER)
    }
    const reported = this.scenario === 'malformed-usage'
      ? { inputTokens: 3, outputTokens: 2, totalTokens: 1 }
      : { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    attempt?.end({ status: 'success', dispatchState: 'sent',
      ...(this.scenario === 'missing-usage' ? {} : { reported }) })
    yield { type: 'text-delta', index: 0, text: 'conformance-ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'conformance-ok' } }
    if (this.scenario !== 'missing-usage') yield { type: 'usage', usage: reported }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const independentProviderFixture = Object.freeze({
  create(input) {
    let enter
    const entered = new Promise(resolve => { enter = resolve })
    const state = { setupCalls: 0, cleanupCalls: 0, dispatchCalls: 0, entered, enter }
    const adapter = new FixtureAdapter(input.scenario, state, input.privateSentinel)
    const active = input.scenario === 'retry-success' || input.scenario === 'retry-exhaustion'
      ? withRetry(adapter, { policy: { mode: 'normal', maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
      : adapter
    const plugin = defineModelProviderPlugin({
      id: input.id, displayName: 'Independent provider fixture', routes: [input.route],
      setup(registrar) {
        state.setupCalls++
        const release = registrar.registerAdapter(active)
        return () => {
          release()
          state.cleanupCalls++
          if (input.scenario === 'cleanup-failure') throw new Error(input.privateSentinel)
          return undefined
        }
      },
    })
    return {
      plugin, route: input.route, model: 'fixture-model', expectedAttempts: 2,
      expectedTotalTokens: 5,
      ...(input.scenario === 'stream-bound-failure'
        ? { expectedFailureCode: 'FIXTURE_STREAM_LIMIT_EXCEEDED' }
        : {}),
      control: {
        snapshot: () => Object.freeze({ setupCalls: state.setupCalls,
          cleanupCalls: state.cleanupCalls, dispatchCalls: state.dispatchCalls }),
        waitForDispatch: () => state.entered,
      },
    }
  },
})
