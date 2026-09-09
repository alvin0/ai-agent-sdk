import { describe, expect, it } from 'vitest'
import {
  createAgentRuntime, defineContextSection, defineSkill, ModelAdapter,
  type GenerateOptions, type StreamChunk,
} from '../../../packages/core/src/index.ts'
import type { ContextSectionScope } from '../../../packages/core/src/index.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'

class RecordingAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runtimeWith(adapter: RecordingAdapter) {
  return await createAgentRuntime({ providers: [{
    kind: 'model-provider-plugin', apiVersion: 1, id: 'p', family: 'f',
    displayName: 'P', routes: ['public'], defaultModel: { provider: 'public', id: 'm' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['public'], adapter) },
  }] })
}

function requestText(options: GenerateOptions | undefined): string {
  return JSON.stringify(options?.messages ?? [])
}

describe('context sections through the composition facade', () => {
  it('accepts a definition-level section and puts it in front of the model', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    try {
      const agent = runtime.agent({
        id: 'sectioned', instructions: 'Answer.', compaction: false,
        contextSections: [defineContextSection({
          id: 'house-rules',
          resolve: () => ({ revision: 'v1', text: 'Prefer small diffs.' }),
        })],
      })

      await agent.generate('go')

      expect(requestText(adapter.requests[0])).toContain('Prefer small diffs.')
    } finally {
      await runtime.close()
    }
  })

  it('accepts a session-level section and keeps one live node across runs', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    try {
      const agent = runtime.agent({ id: 'sectioned', instructions: 'Answer.', compaction: false })
      const session = agent.createSession({
        contextSections: [defineContextSection({
          id: 'workspace',
          resolve: () => ({ revision: 'v1', text: 'Workspace rule.' }),
        })],
      })

      await session.run('first')
      await session.run('second')

      const second = requestText(adapter.requests[1])
      expect(second).toContain('Workspace rule.')
      // A second run must adopt the existing node, not append a duplicate.
      expect(second.split('Workspace rule.').length - 1).toBe(1)
    } finally {
      await runtime.close()
    }
  })

  it('lets a session section replace the definition section that shares its id', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    try {
      const agent = runtime.agent({
        id: 'sectioned', instructions: 'Answer.', compaction: false,
        contextSections: [defineContextSection({
          id: 'workspace',
          resolve: () => ({ revision: 'definition', text: 'Generic workspace rule.' }),
        })],
      })
      const session = agent.createSession({
        contextSections: [defineContextSection({
          id: 'workspace',
          resolve: () => ({ revision: 'session', text: 'This checkout rule.' }),
        })],
      })

      await session.run('go')

      const request = requestText(adapter.requests[0])
      expect(request).toContain('This checkout rule.')
      expect(request).not.toContain('Generic workspace rule.')
    } finally {
      await runtime.close()
    }
  })

  it('gives every team member its own conversation scope from one shared section', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    const seen: ContextSectionScope[] = []
    try {
      // One section object, mounted on one definition, used as two members.
      const shared = defineContextSection({
        id: 'workspace',
        resolve(input) {
          seen.push(input.scope)
          return { revision: 'v1', text: 'Workspace rule.' }
        },
      })
      const agent = runtime.agent({
        id: 'member', instructions: 'Answer.', compaction: false, contextSections: [shared],
      })
      const team = runtime.team({
        id: 'pair',
        members: [{ name: 'lead', agent, role: 'lead' }, { name: 'helper', agent }],
      })

      await team.run('lead', 'go')
      await team.run('helper', 'go')

      expect(seen).toHaveLength(2)
      expect(seen.every(scope => scope.agentId === 'member')).toBe(true)
      // Distinct conversations, so per-conversation section state stays apart.
      expect(seen[0]?.conversationId).toBeDefined()
      expect(seen[0]?.conversationId).not.toBe(seen[1]?.conversationId)
    } finally {
      await runtime.close()
    }
  })

  it('coexists with the skill catalog without either landing in the other\'s channel', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    try {
      const agent = runtime.agent({
        id: 'skilled', instructions: 'Answer.', compaction: false,
        skills: [defineSkill({
          id: 'deploy-runbook', name: 'Deploy runbook',
          description: 'How this service is released.',
          instructions: 'Run the staged rollout.',
        })],
        contextSections: [defineContextSection({
          id: 'workspace',
          resolve: () => ({ revision: 'v1', text: 'Workspace rule.' }),
        })],
      })

      await agent.generate('go')

      const request = adapter.requests[0]
      // The skill catalog is a system-prompt concern; the section is a
      // conversation-surface one. Neither may leak into the other's channel.
      expect(request?.system).toContain('deploy-runbook')
      expect(request?.system).not.toContain('Workspace rule.')
      expect(requestText(request)).toContain('Workspace rule.')
      expect(requestText(request)).not.toContain('Run the staged rollout.')
    } finally {
      await runtime.close()
    }
  })

  it('rejects a malformed section at the composition boundary', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await runtimeWith(adapter)
    try {
      expect(() => runtime.agent({
        id: 'bad', instructions: 'Answer.',
        contextSections: [{ id: 'Not Kebab', resolve: () => undefined }],
      })).toThrow(/kebab-case/)
    } finally {
      await runtime.close()
    }
  })
})
