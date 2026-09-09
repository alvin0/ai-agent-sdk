import { describe, expect, it, vi } from 'vitest'
import * as core from '@ai-agent-sdk/core'
import * as advanced from '@ai-agent-sdk/core/agent'
import * as provider from '@ai-agent-sdk/core/provider'

describe('core author ergonomics', () => {
  it('keeps canonical tool and skill helper identities on root and advanced routes', () => {
    expect(core.defineTool).toBe(advanced.defineTool)
    expect(core.defineSkill).toBe(advanced.defineSkill)
    expect(core.ModelRegistry).toBe(provider.ModelRegistry)
    expect(core.REGISTRY_ERROR_CODES).toBeDefined()
  })

  it('preserves rich tool, skill, native-tool, compaction and session controls', async () => {
    const execute = vi.fn((args: { value: string }, context: advanced.ToolRunContext) => {
      context.signal.throwIfAborted()
      return { value: args.value }
    })
    const tool = core.defineTool({
      name: 'ergonomic_tool', description: 'Exercise the complete author contract.',
      parameters: { type: 'object', required: ['value'] },
      parse(raw): { value: string } {
        if (typeof raw !== 'object' || raw === null || typeof Reflect.get(raw, 'value') !== 'string') {
          throw new TypeError('value is required')
        }
        return { value: Reflect.get(raw, 'value') as string }
      },
      execute,
      render: (_value, args) => [{ type: 'text', text: args.value }],
      meta: (_value, args) => ({ inputLength: args.value.length }),
      timeoutMs: 1_000,
      isConcurrencySafe: () => true,
    })
    const skill = core.defineSkill({
      id: 'ergonomic-skill', name: 'Ergonomic skill', description: 'Rich skill metadata.',
      whenToUse: 'Use during the author-surface regression.', instructions: 'Read the guide.',
      resources: { 'guide/start.md': 'Start.' },
      resourceManifest: [{ path: 'guide/lazy.md', sizeBytes: 9 }],
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'unit', provider: 'inline', resourceBase: { kind: 'opaque', value: 'fixture' },
      path: 'skills/ergonomic/SKILL.md', metadata: { audience: 'test' },
    })
    const agent = core.defineAgent({
      id: 'ergonomic-agent', provider: 'fixture', model: 'fixture-model', instructions: 'Test.',
      tools: [tool], skills: [skill],
      nativeTools: [{ type: 'native', name: 'web-search', searchContextSize: 'high', maxUses: 2 }],
      compaction: { auto: false, maxInputTokens: 8_000, retainTokens: 2_000 },
      maxTurns: 7, maxToolCalls: 11,
    })

    expect(agent).toMatchObject({ maxTurns: 7, maxToolCalls: 11, tools: [tool], skills: [skill] })
    expect(agent.nativeTools).toEqual([{ type: 'native', name: 'web-search', searchContextSize: 'high', maxUses: 2 }])
    expect(skill).toMatchObject({
      invocation: { modelInvocable: false, userInvocable: true },
      resourceBase: { kind: 'opaque', value: 'fixture' }, metadata: { audience: 'test' },
    })
    expect(skill.resourceManifest.map(resource => resource.path)).toEqual(['guide/lazy.md', 'guide/start.md'])
    expect(tool.parse?.({ value: 'ok' })).toEqual({ value: 'ok' })
    expect(tool.timeoutMs).toBe(1_000)

    const registry = new core.ModelRegistry()
    const session = agent.createSession({ registry, runtimeLimits: {
      modelTimeoutMs: 2_000, maxModelRequestBytes: 32_768, maxModelStreamEvents: 128,
      maxToolDurationMs: 1_000, maxParallelToolCalls: 2, observerTimeoutMs: 1_000,
    }, compaction: false })
    const snapshot = JSON.parse(JSON.stringify(session.snapshot())) as advanced.AgentSessionSnapshot
    expect(snapshot).toMatchObject({ version: 1, agentId: 'ergonomic-agent' })
    const resumed = agent.resumeSession({ registry, snapshot, compaction: false })
    await expect(resumed.compact()).resolves.toBeNull()
  })
})
