import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ModelProviderPlugin, ModelProviderRegistrar } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

class PluginAdapter extends ModelAdapter {
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as const })()
  }
}

describe('ModelRegistry provider plugins', () => {
  it('discards all staged changes and notifications when setup throws', () => {
    const registry = new ModelRegistry()
    const listener = vi.fn()
    registry.onAdaptersUpdated(listener)

    expect(() => registry.install({
      id: 'broken',
      displayName: 'Broken',
      setup(registrar) {
        registrar.registerAdapter(['staged'], new PluginAdapter())
        registrar.use((_options, next) => next())
        throw new Error('setup exploded')
      },
    })).toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_FAILED', pluginId: 'broken' }))

    expect(registry.listProviders()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('commits routes and middleware once, then disposes idempotently', async () => {
    const registry = new ModelRegistry()
    const listener = vi.fn()
    const cleanup = vi.fn()
    const middleware = vi.fn((_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => next())
    registry.onAdaptersUpdated(listener)

    const dispose = registry.install({
      id: 'example',
      displayName: 'Example',
      setup(registrar) {
        registrar.registerAdapter(['one', 'two'], new PluginAdapter())
        registrar.use(middleware)
        return cleanup
      },
    })

    expect(dispose.pluginId).toBe('example')
    expect(registry.listProviders().map(provider => provider.id)).toEqual(['one', 'two'])
    expect(listener).toHaveBeenCalledTimes(1)
    for await (const _chunk of registry.stream({ provider: 'one', model: 'm', messages: [] })) { /* drain */ }
    expect(middleware).toHaveBeenCalledTimes(1)

    dispose()
    dispose()
    expect(registry.listProviders()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate plugin ids and duplicate staged routes', () => {
    const registry = new ModelRegistry()
    registry.install({ id: 'same', displayName: 'Same', setup() {} })
    expect(() => registry.install({ id: 'same', displayName: 'Same again', setup() {} }))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_FAILED' }))

    expect(() => registry.install({
      id: 'duplicates',
      displayName: 'Duplicates',
      setup(registrar) {
        registrar.registerAdapter(['route'], new PluginAdapter())
        registrar.registerAdapter(['route'], new PluginAdapter())
      },
    })).toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_FAILED' }))
    expect(registry.listProviders()).toEqual([])
  })

  it('rejects asynchronous setup as one stable transactional install failure', () => {
    const registry = new ModelRegistry()
    expect(() => registry.install({
      id: 'async-setup',
      displayName: 'Async setup',
      setup: (() => Promise.resolve()) as unknown as ModelProviderPlugin['setup'],
    })).toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_FAILED', pluginId: 'async-setup' }))
    expect(registry.listProviders()).toEqual([])
  })

  it('lets setup cancel or replace staged registrations before commit only', () => {
    const registry = new ModelRegistry()
    let retained: ReturnType<ModelProviderRegistrar['registerAdapter']> | undefined
    registry.install({
      id: 'staging-handles',
      displayName: 'Staging handles',
      setup(registrar) {
        const cancelled = registrar.registerAdapter(['cancelled'], new PluginAdapter())
        cancelled()
        retained = registrar.registerAdapter(['before'], new PluginAdapter())
        retained.replace(['after'])
      },
    })
    expect(registry.listProviders().map(provider => provider.id)).toEqual(['after'])
    expect(() => retained?.replace(['too-late'])).toThrow(/staged registration/)
  })

  it('runs setup cleanup after failed commit validation without exposing routes', () => {
    const registry = new ModelRegistry()
    const cleanup = vi.fn()
    class InvalidOnCommitAdapter extends PluginAdapter {
      private calls = 0
      override providerInfo(provider: string) {
        this.calls += 1
        return { id: this.calls === 1 ? provider : 'wrong', name: 'Invalid later' }
      }
    }

    expect(() => registry.install({
      id: 'commit-failure',
      displayName: 'Commit failure',
      setup(registrar) {
        registrar.registerAdapter(['route'], new InvalidOnCommitAdapter())
        return cleanup
      },
    })).toThrow(expect.objectContaining({ code: 'PLUGIN_INSTALL_FAILED' }))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(registry.listProviders()).toEqual([])
  })

  it('removes topology before surfacing cleanup failures and never retries cleanup', () => {
    const registry = new ModelRegistry()
    const cleanup = vi.fn(() => { throw new Error('cleanup failed') })
    const dispose = registry.install({
      id: 'cleanup-failure',
      displayName: 'Cleanup failure',
      setup(registrar) {
        registrar.registerAdapter(['route'], new PluginAdapter())
        return cleanup
      },
    })

    expect(() => dispose()).toThrow(expect.objectContaining({ code: 'PLUGIN_CLEANUP_FAILED' }))
    expect(registry.listProviders()).toEqual([])
    expect(() => dispose()).not.toThrow()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('contains asynchronous cleanup and surfaces one stable cleanup failure', () => {
    const registry = new ModelRegistry()
    const dispose = registry.install({
      id: 'async-cleanup',
      displayName: 'Async cleanup',
      setup() {
        return (async () => { throw new Error('late cleanup rejection') }) as unknown as () => void
      },
    })
    expect(() => dispose()).toThrow(expect.objectContaining({
      code: 'PLUGIN_CLEANUP_FAILED',
      pluginId: 'async-cleanup',
    }))
    expect(() => dispose()).not.toThrow()
  })
})
