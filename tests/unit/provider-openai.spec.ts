import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '@ai-agent-sdk/core'
import {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
} from '@ai-agent-sdk/provider-openai'

describe('Universal OpenAI provider plugin', () => {
  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = openAiAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('openai')).toEqual({ id: 'openai', name: 'OpenAI' })
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(resolutions).toBe(0)
  })

  it('installs custom routes transactionally', () => {
    const registry = new ModelRegistry()
    const dispose = registry.install(openAiPlugin({
      apiKey: 'injected-key',
      routes: ['openai', 'compatible-gateway'],
    }))
    expect(registry.listProviders()).toEqual([
      { id: 'openai', name: 'OpenAI' },
      { id: 'compatible-gateway', name: 'OpenAI' },
    ])
    dispose()
    expect(registry.listProviders()).toEqual([])
  })
})
