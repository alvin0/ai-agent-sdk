import { describe, expect, it } from 'vitest'
import { ModelRegistry, createAgentRuntime } from '@ai-agent-sdk/core'
import {
  ANTHROPIC_BASE_URL,
  anthropicAdapter,
  anthropicPlugin,
} from '@ai-agent-sdk/provider-anthropic'
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

const ANTHROPIC_TEXT = [
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"content_block_stop","index":0}',
]

const anthropicConformance = officialProviderConformanceFixture({
  family: 'anthropic',
  model: 'claude-conformance',
  completeFrames: [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
  ],
  missingUsageFrames: [
    'data: {"type":"message_start","message":{"id":"m1"}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'data: {"type":"message_stop"}',
  ],
  malformedUsageFrames: [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":"private-invalid-counter"}}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
  ],
  createAdapter: input => anthropicAdapter({ apiKey: 'private-anthropic-key', ...input }),
})

describe('Universal Anthropic provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(anthropicConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

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
    expect('kind' in plugin).toBe(false)
    expect(registry.listProviders()).toEqual([])
    const dispose = registry.install(plugin)
    expect(registry.listProviders()).toEqual([{ id: 'anthropic', name: 'Anthropic' }])
    expect(resolutions).toBe(0)
    dispose()
    expect(registry.listProviders()).toEqual([])
  })

  it('creates a composable provider with an independent route and fallback model', async () => {
    const plugin = anthropicPlugin({
      id: 'anthropic-research',
      apiKey: 'research-key',
      defaultModel: 'claude-research',
    })
    expect(plugin).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'anthropic-research',
      family: 'anthropic', routes: ['anthropic-research'],
      defaultModel: { provider: 'anthropic-research', id: 'claude-research' },
    })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    try {
      expect(runtime.providers()[0]).toMatchObject({
        route: 'anthropic-research', pluginId: 'anthropic-research', family: 'anthropic',
      })
    } finally {
      await runtime.close()
    }
  })
})
