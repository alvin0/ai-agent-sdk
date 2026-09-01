import { describe, expect, it } from 'vitest'
import {
  AgentTeam,
  createDefinedAgentTeam,
  createManagedAgentTeam,
} from '../../src/agent/a2a/index.ts'
import { defineAgent } from '../../src/agent/define/index.ts'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

class TextAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * textRound('done')
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve(modelInfo(provider, model))
  }
}

class DelegatingAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  activeWorkers = 0
  maxActiveWorkers = 0

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const toolNames = options.tools?.map(tool => tool.name) ?? []
    const hasSpawn = toolNames.includes('spawn_agent')
    const hasToolResult = options.messages.some(message => message.source.kind === 'tool')
    if (hasSpawn && !hasToolResult) {
      yield {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: ToolCallId('spawn-a'), name: 'spawn_agent',
          arguments: JSON.stringify({ name: 'worker_a', task: 'Analyze A', specialty: 'analysis' }),
        },
      }
      yield {
        type: 'block-end', index: 1,
        block: {
          type: 'tool-call', id: ToolCallId('spawn-b'), name: 'spawn_agent',
          arguments: JSON.stringify({ name: 'worker_b', task: 'Analyze B', specialty: 'verification' }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (!hasSpawn) {
      this.activeWorkers++
      this.maxActiveWorkers = Math.max(this.maxActiveWorkers, this.activeWorkers)
      await new Promise(resolve => setTimeout(resolve, 20))
      const task = options.messages.find(message => message.source.kind === 'agent-message')
        ?.content.filter(block => block.type === 'text').at(-1)
      const text = task?.type === 'text' ? `Result for ${task.text}` : 'Worker result'
      this.activeWorkers--
      yield * textRound(text)
      return
    }
    yield * textRound('Lead synthesized both worker results.')
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve(modelInfo(provider, model))
  }
}

function modelInfo(provider: string, model: string): ResolvedModelInfo {
  const medium = ReasoningEffortId('medium')
  return {
    provider, id: model, name: model,
    reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
  }
}

function registryWith(adapter: ModelAdapter): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return registry
}

function agent(id: string) {
  return defineAgent({ id, provider: 'test', model: 'scripted', instructions: `You are ${id}.` })
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('two agent-team concepts', () => {
  it('composes pre-defined agents into stable, addressable sessions', async () => {
    const adapter = new TextAdapter()
    const composed = createDefinedAgentTeam({
      registry: registryWith(adapter),
      team: { id: 'defined-team' },
      members: [
        { agent: agent('reviewer'), description: 'Reviews changes.' },
        { agent: agent('lead'), role: 'lead' },
      ],
    })

    expect(composed.sessionNames()).toEqual(['reviewer', 'lead'])
    expect(composed.team.members()).toMatchObject([
      { name: 'reviewer', kind: 'local', role: 'peer' },
      { name: 'lead', kind: 'local', role: 'lead' },
    ])

    await composed.team.sendMessage({
      from: 'lead', target: 'reviewer', message: 'Review commit abc.', delivery: 'quiet',
    })
    const delivered = composed.session('reviewer').history.entries().at(-1)
    expect(delivered?.event.kind === 'user' && delivered.event.message.source).toMatchObject({
      kind: 'agent-message', sender: 'lead', teamId: 'defined-team',
    })
    await composed.run('lead', 'Coordinate the review.')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual([
      'list_agents', 'send_message', 'followup_task', 'wait_agents',
    ])
    await expect(composed.run('missing', 'work')).rejects.toThrow(/unknown defined team member/)
  })

  it('rolls back composed members when topology construction fails', () => {
    const team = new AgentTeam({ id: 'atomic-team' })
    const registry = registryWith(new TextAdapter())
    expect(() => createDefinedAgentTeam({
      registry,
      team,
      members: [
        { agent: agent('first'), name: 'duplicate' },
        { agent: agent('second'), name: 'duplicate' },
      ],
    })).toThrow(/already attached or linked/)
    expect(team.members()).toEqual([])
  })

  it('lets a managed lead generate workers and divide independent work in parallel', async () => {
    const adapter = new DelegatingAdapter()
    const harness = createManagedAgentTeam({
      registry: registryWith(adapter),
      lead: agent('lead'),
      team: { id: 'managed-team' },
      maxWorkers: 2,
    })

    const response = await harness.run('Split A and B across specialists, then synthesize.')

    expect(response.text).toBe('Lead synthesized both worker results.')
    expect(adapter.maxActiveWorkers).toBe(2)
    expect(adapter.requests[0]?.system).toContain('managed dynamic team')
    expect(adapter.requests.find(request =>
      request.tools?.every(tool => tool.name !== 'spawn_agent'))?.system)
      .toContain('dynamically created worker')
    expect(harness.workers()).toMatchObject([
      {
        name: 'worker_a', agentId: 'worker_a', task: 'Analyze A',
        specialty: 'analysis', status: 'completed',
        result: { text: 'Result for Analyze A', succeeded: true },
      },
      {
        name: 'worker_b', agentId: 'worker_b', task: 'Analyze B',
        specialty: 'verification', status: 'completed',
        result: { text: 'Result for Analyze B', succeeded: true },
      },
    ])
    expect(harness.team.members().map(member => member.name)).toEqual([
      'lead', 'worker_a', 'worker_b',
    ])
    expect(harness.team.messages()).toHaveLength(2)
    expect(harness.team.messages()[0]).toMatchObject({
      sender: 'lead', target: 'worker_a', delivery: 'quiet',
    })
    const finalLeadRequest = adapter.requests.at(-1)
    const toolResults = finalLeadRequest?.messages.filter(message => message.source.kind === 'tool') ?? []
    expect(JSON.stringify(toolResults)).toContain('worker_a')
    expect(JSON.stringify(toolResults)).toContain('Result for Analyze B')
    await expect(harness.spawn({ task: 'One more task' })).rejects.toThrow(/2-worker limit/)
  })

  it('supports host-driven worker creation and lifecycle cleanup', async () => {
    const adapter = new TextAdapter()
    const harness = createManagedAgentTeam({
      registry: registryWith(adapter), lead: agent('lead'), maxWorkers: 1,
    })

    const result = await harness.spawn({ task: 'Inspect logs', specialty: 'operations' })
    expect(result).toMatchObject({ worker: 'worker_1', agentId: 'worker_1', text: 'done' })
    expect(harness.team.members().some(member => member.name === 'worker_1')).toBe(true)

    harness.removeWorker('worker_1')
    expect(harness.workers()).toEqual([])
    expect(harness.team.members().some(member => member.name === 'worker_1')).toBe(false)
  })
})
