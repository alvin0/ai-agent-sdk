import {
  ModelAdapter,
  ModelError,
  ModelRegistry,
  withRetry,
  type GenerateOptions,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { runBoundedWorkers, StressChecks } from './shared.ts'

export async function pluginRetryPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  let retries = 0
  let cleanups = 0
  let brokenInstalls = 0
  let notifications = 0
  const failures: string[] = []
  await runBoundedWorkers(context.iterations, 32, context.signal, async index => {
    const registry = new ModelRegistry()
    registry.onAdaptersUpdated(() => { notifications++ })
    if (index % 7 === 0) {
      try {
        registry.install({
          id: `broken-${index}`, displayName: 'Broken stress plugin',
          setup(registrar) {
            registrar.registerAdapter([`leaked-${index}`], new FlakyAdapter())
            throw new Error('deterministic setup failure')
          },
        })
        failures.push(`broken plugin ${index} unexpectedly installed`)
      } catch (error: unknown) {
        if (Reflect.get(error as object, 'code') === 'PLUGIN_INSTALL_FAILED'
          && registry.listProviders().length === 0) brokenInstalls++
        else failures.push(`broken plugin ${index} exposed staged state`)
      }
    }
    const adapter = new FlakyAdapter()
    const dispose = registry.install({
      id: `plugin-${index}`, displayName: 'Stress plugin',
      setup(registrar) {
        registrar.registerAdapter([`provider-${index}`], withRetry(adapter, {
          policy: {
            mode: 'normal', maxRetries: 2,
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
          random: () => 0.5,
          onRetry: () => { retries++ },
        }))
        return () => { cleanups++ }
      },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of registry.stream({
      provider: `provider-${index}`, model: 'retry-model', messages: [], signal: context.signal,
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    if (adapter.attempts !== 2 || finish?.type !== 'finish' || finish.reason.kind !== 'stop') {
      failures.push(`plugin ${index} attempts=${adapter.attempts} finish=${finish?.type === 'finish' ? finish.reason.kind : 'missing'}`)
    }
    dispose()
    dispose()
    if (registry.listProviders().length !== 0) failures.push(`plugin ${index} route survived dispose`)
    if (index < 4 || index === context.iterations - 1) {
      context.artifact.record('plugin-sample', {
        index, attempts: adapter.attempts, chunks: chunks.map(chunk => chunk.type),
        providersAfterDispose: registry.listProviders().map(provider => provider.id),
      })
    }
  })
  checks.equal('every successful physical call retries exactly once', retries, context.iterations)
  checks.equal('every committed plugin cleanup runs exactly once', cleanups, context.iterations)
  checks.equal('broken setup transactions expose no staged routes', brokenInstalls,
    Math.floor((context.iterations - 1) / 7) + 1)
  checks.check('plugin install/stream/dispose cycles leave no topology leak', failures.length === 0,
    failures.slice(0, 8).join('; '))
  checks.equal('adapter update notifications cover commit and removal only', notifications, context.iterations * 2)
  return Object.freeze({
    invariants: checks.items(),
    metrics: Object.freeze({ iterations: context.iterations, retries, cleanups, brokenInstalls, notifications }),
  })
}

class FlakyAdapter extends ModelAdapter {
  attempts = 0
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.attempts++
    if (this.attempts === 1) throw new ModelError('transient stress failure', 'SERVER')
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'recovered' } as const
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as const
      yield { type: 'finish', reason: { kind: 'stop' } } as const
    })()
  }
}

