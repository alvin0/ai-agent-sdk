import { describe, expect, it } from 'vitest'
import {
  MODEL_ERROR_CODES,
  ModelAdapter,
  ModelError,
  withRetry,
  type GenerateOptions,
  type ModelInvocationContext,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import {
  runProviderConformanceSuite,
  type ProviderConformanceCase,
  type ProviderConformanceCaseInput,
  type ProviderConformanceControlSnapshot,
  type ProviderConformanceFixture,
} from '@ai-agent-sdk/testkit'

interface State {
  setupCalls: number
  cleanupCalls: number
  dispatchCalls: number
  entered: Promise<void>
  enter(): void
}

function state(): State {
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { setupCalls: 0, cleanupCalls: 0, dispatchCalls: 0, entered, enter }
}

class FixtureAdapter extends ModelAdapter {
  constructor(
    private readonly scenario: ProviderConformanceCaseInput['scenario'],
    private readonly state: State,
    private readonly privateSentinel: string,
  ) { super() }

  override listModels(provider: string) {
    if (this.scenario === 'catalog-failure') return Promise.reject(new Error('catalog fixture failure'))
    if (this.scenario === 'catalog-empty') return Promise.resolve([])
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture model' }])
  }

  override async *stream(
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk> {
    context?.declareProviderAttemptAccounting?.()
    const attempt = await context?.startProviderAttempt?.({
      provider: options.provider, model: options.model,
      method: 'POST', origin: 'https://conformance.invalid',
    }, options.signal)
    this.state.dispatchCalls++
    this.state.enter()

    if (this.scenario === 'stream-bound-failure') {
      attempt?.end({
        status: 'error', dispatchState: 'sent',
        error: { type: 'ModelError', message: 'provider stream exceeded configured bound',
          code: 'FIXTURE_STREAM_LIMIT_EXCEEDED' },
      })
      throw new ModelError('provider stream exceeded configured bound', 'FIXTURE_STREAM_LIMIT_EXCEEDED', {
        cause: new Error(this.privateSentinel),
      })
    }

    if (this.scenario === 'abort-in-flight') {
      try {
        await new Promise<void>((_resolve, reject) => {
          const signal = options.signal
          if (signal?.aborted) { reject(signal.reason); return }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      } catch (error) {
        attempt?.end({ status: 'aborted', dispatchState: 'unknown' })
        throw new ModelError('conformance request aborted', MODEL_ERROR_CODES.ABORTED, { cause: error })
      }
    }

    const retryFailure = this.scenario === 'retry-exhaustion'
      || (this.scenario === 'retry-success' && this.state.dispatchCalls === 1)
    if (retryFailure) {
      attempt?.end({
        status: 'error', dispatchState: 'sent',
        error: { type: 'ModelError', message: 'conformance transient failure', code: MODEL_ERROR_CODES.SERVER },
      })
      throw new ModelError('conformance transient failure', MODEL_ERROR_CODES.SERVER)
    }

    const reported = this.scenario === 'malformed-usage'
      ? { inputTokens: 3, outputTokens: 2, totalTokens: 1 }
      : { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    attempt?.end({
      status: 'success', dispatchState: 'sent',
      ...this.scenario === 'missing-usage' ? {} : { reported },
    })
    yield { type: 'text-delta', index: 0, text: 'conformance-ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'conformance-ok' } }
    if (this.scenario !== 'missing-usage') yield { type: 'usage', usage: reported }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const fixture: ProviderConformanceFixture = {
  create(input): ProviderConformanceCase {
    const mutable = state()
    const adapter = new FixtureAdapter(input.scenario, mutable, input.privateSentinel)
    const active = input.scenario === 'retry-success' || input.scenario === 'retry-exhaustion'
      ? withRetry(adapter, {
        policy: {
          mode: 'normal', maxRetries: 1,
          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        },
      })
      : adapter
    const plugin: ComposableModelProviderPlugin = defineModelProviderPlugin({
      id: input.id,
      displayName: 'Conformance fixture',
      routes: [input.route],
      setup(registrar) {
        mutable.setupCalls++
        const release = registrar.registerAdapter(active)
        return () => {
          release()
          mutable.cleanupCalls++
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
        snapshot(): ProviderConformanceControlSnapshot {
          return Object.freeze({
            setupCalls: mutable.setupCalls,
            cleanupCalls: mutable.cleanupCalls,
            dispatchCalls: mutable.dispatchCalls,
          })
        },
        waitForDispatch: () => mutable.entered,
      },
    }
  },
}

describe('framework-independent provider testkit', () => {
  it('passes the complete deterministic provider conformance matrix', async () => {
    const report = await runProviderConformanceSuite(fixture, { caseTimeoutMs: 1_000 })
    expect(report).toMatchObject({ schemaVersion: 1, status: 'passed', failed: 0, passed: 19 })
    expect(report.checks).toHaveLength(19)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.checks)).toBe(true)
  })
})
