import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '@ai-agent-sdk/core'
import {
  ANTHROPIC_BASE_URL,
  anthropicAdapter,
  anthropicPlugin,
} from '@ai-agent-sdk/provider-anthropic'

describe('Universal Anthropic provider plugin', () => {
  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = anthropicAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('anthropic')).toEqual({ id: 'anthropic', name: 'Anthropic' })
    expect(ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(resolutions).toBe(0)
  })

  it('installs and disposes transactionally without ambient registration', () => {
    let resolutions = 0
    const registry = new ModelRegistry()
    const plugin = anthropicPlugin({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(registry.listProviders()).toEqual([])
    const dispose = registry.install(plugin)
    expect(registry.listProviders()).toEqual([{ id: 'anthropic', name: 'Anthropic' }])
    expect(resolutions).toBe(0)
    dispose()
    expect(registry.listProviders()).toEqual([])
  })
})
