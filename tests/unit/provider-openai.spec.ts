import { describe, expect, it } from 'vitest'
import { createAgentRuntime } from '@ai-agent-sdk/core'
import {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
} from '@ai-agent-sdk/provider-openai'
import { runProviderConformanceSuite } from '@ai-agent-sdk/testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

const RESPONSES_TEXT = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"ok"}]}}',
]

const openAiConformance = officialProviderConformanceFixture({
  family: 'openai',
  model: 'gpt-conformance',
  completeFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'],
  missingUsageFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1"}}'],
  malformedUsageFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}'],
  createAdapter: input => openAiAdapter({ apiKey: 'private-openai-key', ...input }),
})

describe('Universal OpenAI provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(openAiConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = openAiAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('openai')).toEqual({ id: 'openai', name: 'OpenAI' })
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(resolutions).toBe(0)
  })

  it('installs preferred custom aliases transactionally', async () => {
    const plugin = openAiPlugin({
      apiKey: 'injected-key',
      routes: ['openai', 'compatible-gateway'],
    })
    expect(plugin).toMatchObject({
      kind: 'model-provider-plugin', id: 'openai', family: 'openai',
      routes: ['openai', 'compatible-gateway'],
    })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    expect(runtime.providers().map(provider => provider.route)).toEqual([
      'openai', 'compatible-gateway',
    ])
    await runtime.close()
  })

  it('creates independent composable instances with route-scoped model defaults', async () => {
    const first = openAiPlugin({
      id: 'openai-team-a',
      apiKey: 'team-a-key',
      defaultModel: 'model-a',
    })
    const second = openAiPlugin({
      id: 'openai-team-b',
      apiKey: 'team-b-key',
      defaultModel: { provider: 'openai-team-b', id: 'model-b' },
    })
    expect(first).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'openai-team-a',
      family: 'openai', routes: ['openai-team-a'],
      defaultModel: { provider: 'openai-team-a', id: 'model-a' },
    })

    const runtime = await createAgentRuntime({ providers: [first, second] })
    try {
      expect(runtime.providers()).toEqual([
        expect.objectContaining({
          route: 'openai-team-a', pluginId: 'openai-team-a', family: 'openai',
          defaultModel: { provider: 'openai-team-a', id: 'model-a' },
        }),
        expect.objectContaining({
          route: 'openai-team-b', pluginId: 'openai-team-b', family: 'openai',
          defaultModel: { provider: 'openai-team-b', id: 'model-b' },
        }),
      ])
    } finally {
      await runtime.close()
    }
  })
})
