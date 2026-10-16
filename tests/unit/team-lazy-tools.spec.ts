import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent, defineSkill, defineTool } from '../../packages/core/src/agent/index.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { CombinedToolCatalog } from '../../packages/core/src/agent/mode/support/control-catalog.ts'
import type { ManagedAgentTeamOptions } from '../../packages/core/src/agent/index.ts'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '../../packages/core/src/index.ts'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '../../packages/core/src/index.ts'

const full = ['spawn_agent', 'close_agent', 'send_input', 'wait_agents', 'get_agent_result']
const names = (request: GenerateOptions) => request.tools?.map(tool => tool.name) ?? []
const answer = (text: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
let nextCall = 0
const call = (name: string, args: unknown, index = 0): StreamChunk[] => [
  { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`call-${name}-${++nextCall}`),
    name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

class Script extends ModelAdapter {
  readonly leads: GenerateOptions[] = []
  readonly workers: GenerateOptions[] = []
  constructor(readonly steps: ((request: GenerateOptions) => StreamChunk[])[] = []) { super() }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: medium, name: 'medium' }] } })
  }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    if (request.system?.includes("managed worker '")) {
      this.workers.push(request)
      yield* answer('worker-evidence')
    } else {
      this.leads.push(request)
      const step = this.steps[this.leads.length - 1]
      if (step !== undefined) yield* step(request)
      else if (names(request).includes('submit_result')) {
        const submitted = request.messages.some(message => message.role === 'assistant'
          && message.content.some(block => block.type === 'tool-call' && block.name === 'submit_result'))
        yield* submitted ? answer('final') : call('submit_result', { summary: 'Verified.', evidence: ['worker checked'] })
      } else yield* answer('final')
    }
  }
}

function setup(adapter: Script, options: Partial<ManagedAgentTeamOptions> = {}) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return createManagedAgentTeam({ registry,
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.',
      maxTurns: 16, compaction: false }),
    ...options })
}

describe('progressive managed tool disclosure', () => {
  it('keeps repeated no-spawn calls byte-stable, with host tools before spawn', async () => {
    const host = defineTool({ name: 'read_file', description: 'Read.', parameters: { type: 'object' },
      execute: () => 'read' })
    const adapter = new Script()
    const team = setup(adapter, { leadSessionOptions: { tools: [host] } })
    try {
      await team.run('first')
      await team.run('second')
      expect(names(adapter.leads[0]!)).toEqual(['read_file', 'spawn_agent'])
      expect(adapter.leads[0]!.tools).toEqual(adapter.leads[1]!.tools)
      expect(adapter.leads[0]!.system).toBe(adapter.leads[1]!.system)
      expect(team.lead.effectiveCatalog()?.get('wait_agents')).toBeUndefined()
      expect(team.lead.effectiveCatalog()?.executionMode('wait_agents', {})).toBe('exclusive')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('preserves explicit delegation and host-owned continuation in the short prompt', async () => {
    const adapter = new Script()
    const team = setup(adapter, { delegationMode: 'explicit', autoLeadCoordination: false })
    try {
      await team.run('inspect')
      expect(adapter.leads[0]!.system).toContain('Delegate only when the user or host explicitly asks.')
      expect(adapter.leads[0]!.system).toContain('the host controls later turns')
      expect(adapter.leads[0]!.system).not.toContain('End your turn')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('keeps skill tool schemas in the initial prefix when controls appear', async () => {
    const adapter = new Script()
    const team = setup(adapter, { autoLeadCoordination: false,
      lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.',
        skills: [defineSkill({ id: 'inspect', name: 'Inspect', description: 'Inspect the workspace.',
          whenToUse: 'Inspect files.', instructions: 'Read carefully.' })] }) })
    try {
      await team.run('before')
      const initial = adapter.leads[0]!.tools!
      expect(initial.length).toBeGreaterThan(1)
      const worker = await team.spawn({ task: 'inspect' })
      await team.awaitWorker(worker.name)
      await team.run('after')
      expect(adapter.leads.at(-1)!.tools!.slice(0, initial.length)).toEqual(initial)
      expect(names(adapter.leads.at(-1)!).slice(initial.length)).toEqual(full.slice(1))
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('appends detailed guidance only once across parallel spawns', async () => {
    const adapter = new Script([
      () => [...call('spawn_agent', { task: 'first' }).slice(0, 1),
        ...call('spawn_agent', { task: 'second' }, 1).slice(0, 1),
        { type: 'finish', reason: { kind: 'tool-calls' } }],
    ])
    const team = setup(adapter, { autoLeadCoordination: false })
    try {
      await team.run('parallel work')
      expect(team.workers()).toHaveLength(2)
      const results = team.lead.history.messages().flatMap(message => message.content)
        .flatMap(block => block.type === 'tool-result' ? block.content : [])
        .filter(block => block.type === 'text').map(block => block.text)
      expect(results.filter(text => text.includes('Plan the next local step'))).toHaveLength(1)
      expect(names(adapter.leads[1]!)).toEqual(full)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['basic', 'deep'] as const)('adds and executes every control mid-session in %s mode', async mode => {
    const adapter = new Script([
      () => call('spawn_agent', { task: 'Return evidence.' }),
      () => call('send_input', { target: 'worker_1', message: 'Verify again.' }),
      () => call('wait_agents', {}),
      () => call('get_agent_result', { target: 'worker_1' }),
      () => call('close_agent', { target: 'worker_1' }),
    ])
    const team = setup(adapter, { autoLeadCoordination: false,
      lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.',
        mode, maxTurns: 16, compaction: false }) })
    try {
      await team.run('work')
      expect(names(adapter.leads[0]!).filter(name => full.includes(name))).toEqual(['spawn_agent'])
      for (const request of adapter.leads.slice(1)) {
        expect(names(request).filter(name => full.includes(name))).toEqual(full)
        expect(request.system).toBe(adapter.leads[0]!.system)
      }
      expect(adapter.leads[1]!.tools?.[0]).toEqual(adapter.leads[0]!.tools?.[0])
      expect(JSON.stringify(adapter.leads[1]!.messages)).toContain('Plan the next local step')
      expect(JSON.stringify(adapter.leads.at(-1)!.messages)).toContain('worker-evidence')
      const results = adapter.leads.at(-1)!.messages.flatMap(message => message.content)
        .flatMap(block => block.type === 'tool-result' ? block.content : [])
        .filter(block => block.type === 'text').map(block => block.text)
      expect(results).toContain('{"target":"worker_1","closed":true}')
      expect(team.workers()).toHaveLength(0)
      // Monotonic even after close: retained reads and subsequent spawns remain discoverable.
      await team.run('next')
      expect(names(adapter.leads.at(-1)!).filter(name => full.includes(name))).toEqual(full)
      expect(names(adapter.workers[0]!).filter(name => full.includes(name))).toEqual(['send_input'])
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('rejects guessed hidden controls and does not disclose after a rejected spawn', async () => {
    const adapter = new Script([
      () => call('spawn_agent', { task: 'work', role: 'undeclared' }),
      () => call('spawn_agent', { task: 'work' }),
    ])
    const team = setup(adapter, { autoLeadCoordination: false })
    try {
      await team.run('work')
      expect(adapter.leads.slice(0, 2).map(names)).toEqual([['spawn_agent'], ['spawn_agent']])
      expect(names(adapter.leads[2]!)).toEqual(full)
      expect(team.workers()).toHaveLength(1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('fails closed when the model guesses an undisclosed control', async () => {
    const adapter = new Script([() => call('close_agent', { target: 'unknown' })])
    const team = setup(adapter)
    try {
      await team.run('work')
      expect(JSON.stringify(team.lead.history.messages())).toContain('no tool named')
      expect(team.lead.effectiveCatalog()?.get('close_agent')).toBeUndefined()
      expect(team.workers()).toHaveLength(0)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('discloses after a host spawn and preserves full worker access', async () => {
    const adapter = new Script()
    const team = setup(adapter, { workerTeamTools: 'full', autoLeadCoordination: false })
    try {
      await team.run('before')
      const worker = await team.spawn({ task: 'work' })
      await team.awaitWorker(worker.name)
      await team.run('after')
      expect(names(adapter.leads[0]!)).toEqual(['spawn_agent'])
      expect(names(adapter.leads.at(-1)!)).toEqual(full)
      expect(names(adapter.workers[0]!)).toEqual(['send_input', 'wait_agents', 'get_agent_result'])
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each([
    { progressiveToolDisclosure: false }, { collaboration: true }, { modelToolSurface: 'legacy' as const },
    { maxDepth: 0 },
  ])('keeps eager discovery when configured or required: %j', async options => {
    const adapter = new Script()
    const team = setup(adapter, options)
    try {
      await team.run('work')
      expect(names(adapter.leads[0]!)).toContain('wait_agents')
      if (options.maxDepth === 0) expect(names(adapter.leads[0]!)).not.toContain('spawn_agent')
    } finally { await team.dispose(); await team.team.dispose() }
  })
})

it('keeps dynamic catalogs live through mode composition and rejects late reserved collisions', () => {
  const base = new ToolRegistry()
  const tool = (name: string) => defineTool({ name, description: 'Test.',
    parameters: { type: 'object' }, execute: () => 'ok', isConcurrencySafe: () => true })
  const combined = new CombinedToolCatalog(base, [tool('submit_result')])
  base.register(tool('new_tool'))
  expect(combined.names()).toEqual(['new_tool', 'submit_result'])
  expect(combined.schemas().map(tool => tool.name)).toEqual(combined.names())
  expect(combined.get('new_tool')).toBeDefined()
  expect(combined.executionMode('new_tool', {})).toBe('parallel')
  base.register(tool('submit_result'))
  expect(() => combined.get('submit_result')).toThrow('reserved')
  expect(() => combined.names()).toThrow('reserved')
  expect(() => combined.schemas()).toThrow('reserved')
})
