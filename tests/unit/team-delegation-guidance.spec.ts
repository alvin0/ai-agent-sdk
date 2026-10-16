import { describe, expect, it, vi } from 'vitest'
import {
  buildDelegationStrategy, DELEGATION_STRATEGY, defineAgent, defineSkill, defineTool,
  filterToolsByDepth, managedAgentRolePresets, MANAGED_DELEGATION_RUNTIME, ToolRegistry,
} from '@alvin0/ai-agent-sdk-core/agent'
import { names, read, setup, workerRequest, write, writeExecute } from '../helpers/managed-team.ts'

const leadSkill = defineSkill({ id: 'lead-skill', name: 'Lead skill', description: 'Lead workflow.',
  whenToUse: 'Lead work.', instructions: 'Use the lead workflow.' })
const workerSkill = defineSkill({ id: 'worker-skill', name: 'Worker skill', description: 'Worker workflow.',
  whenToUse: 'Worker work.', instructions: 'Use the worker workflow.' })
const capableLead = defineAgent({ id: 'capable-lead', provider: 'test', model: 'scripted',
  instructions: 'Solve the caller task.', compaction: false, tools: [read],
  nativeTools: [{ type: 'native', name: 'web-search' }], skills: [leadSkill], skillIds: ['lead-skill'] })

describe('managed delegation guidance', () => {
  it('defaults to proactive with a short, concrete lead strategy', async () => {
    const { adapter, managed } = setup()
    try {
      await managed.run('inspect')
      const system = String(adapter.requests[0]!.system)
      expect(system.slice(system.indexOf('Use your managed team proactively'))).toMatchSnapshot()
      const tools = adapter.requests[0]!.tools ?? []
      expect(Object.fromEntries(tools.filter(tool =>
        ['spawn_agent', 'wait_agents', 'send_message', 'followup_task'].includes(tool.name))
        .map(tool => [tool.name, 'description' in tool ? tool.description : '']))).toMatchSnapshot()
    } finally { await managed.dispose() }
  })

  it('explicit mode requires a request to delegate without removing host hooks', async () => {
    const { adapter, managed } = setup({ delegationMode: 'explicit' })
    try {
      await managed.run('inspect')
      expect(adapter.requests[0]!.system).toContain('Delegate only when the user or host instructions explicitly ask')
      expect(adapter.requests[0]!.system).not.toContain('Use your managed team proactively')
      expect(names(adapter.requests[0]!)).toContain('spawn_agent')
      const worker = await managed.spawn({ task: 'host-authorized work' })
      expect((await managed.awaitWorker(worker.name))?.succeeded).toBe(true)
    } finally { await managed.dispose() }
  })

  it('does not promise automatic continuation when the host disables it', async () => {
    const { adapter, managed } = setup({ autoLeadCoordination: false })
    try {
      await managed.run('inspect')
      expect(adapter.requests[0]!.system).toContain('the host controls later turns')
      expect(adapter.requests[0]!.system).not.toContain('end your turn instead of polling')
    } finally { await managed.dispose() }
  })

  it('exports reusable strategy without managed runtime facts', () => {
    for (const mode of ['explicit', 'proactive'] as const) {
      const strategy = buildDelegationStrategy(mode)
      expect(strategy).toContain(DELEGATION_STRATEGY)
      expect(strategy).not.toContain('Runtime:')
      expect(strategy).not.toContain('close_agent')
    }
    expect(MANAGED_DELEGATION_RUNTIME).toContain('results are pushed automatically')
    expect(MANAGED_DELEGATION_RUNTIME).toContain('wait_agents joins selected workers')
    expect(MANAGED_DELEGATION_RUNTIME).toContain('auto-release slots')
  })

  it('gives workers a focused system section with scope, evidence, and blocker guidance', async () => {
    const { request } = await workerRequest({}, { task: 'Fix parser. Verify with unit tests.', writes: ['src/parser'] })
    const system = String(request.system)
    const start = system.indexOf("You are managed worker 'worker_1'. Focus")
    expect(start).toBeGreaterThan(0)
    expect(system.slice(start)).toMatchSnapshot()
    expect(system).toContain('Assigned write scope: src/parser.')
    expect(system.match(/You are (?:managed|dynamically assigned) worker/g)).toHaveLength(1)
    expect(system).not.toContain('Delegation depth limit reached')
  })
})

describe('worker application tools and role narrowing', () => {
  it('inherits both definition and session tools without lead-bound controls', async () => {
    const catalog = new ToolRegistry()
    catalog.register(write)
    const { request } = await workerRequest({ leadSessionOptions: { tools: catalog } })
    expect(names(request)).toEqual(['read_file', 'write_file', 'list_agents', 'get_agent_result', 'send_message'])
  })

  it('allows explicit replacement, including opting out with an empty array', async () => {
    const replaced = await workerRequest({ leadSessionOptions: { tools: [write] },
      workerSessionOptions: { tools: [write] } })
    expect(names(replaced.request)).toEqual(['write_file', 'list_agents', 'get_agent_result', 'send_message'])
    const empty = await workerRequest({ workerSessionOptions: { tools: [] } })
    expect(names(empty.request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
  })

  it('can disable all lead tool inheritance without supplying a replacement', async () => {
    const { request } = await workerRequest({ inheritLeadTools: false, leadSessionOptions: { tools: [write] } })
    expect(names(request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
  })

  it('preserves a base empty tool grant when the scoped tools are undefined', async () => {
    writeExecute.mockClear()
    const { adapter, managed } = setup({ leadSessionOptions: { tools: [write] },
      workerSessionOptions: { tools: [] }, workerSessionOptionsFactory: () => ({ tools: undefined }) })
    adapter.attemptTool = 'write_file'
    try {
      const worker = await managed.spawn({ task: 'Inspect only' })
      await managed.awaitWorker(worker.name)
      expect(names(adapter.requests[0]!)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
      expect(writeExecute).not.toHaveBeenCalled()
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('no tool named')
    } finally { await managed.dispose() }
  })

  it.each([true, false])('honors inheritLeadTools=%s for cloned native tools and skills', async inheritLeadTools => {
    const { request } = await workerRequest({ lead: capableLead, inheritLeadTools })
    if (inheritLeadTools) {
      expect(names(request)).toContain('web-search')
      expect(names(request)).toContain('load_skill')
      expect(request.system).toContain('lead-skill')
    } else {
      expect(names(request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
      expect(request.system).not.toContain('lead-skill')
    }
    expect(capableLead.nativeTools).toHaveLength(1)
    expect(capableLead.skills).toEqual([leadSkill])
    expect(capableLead.skillIds).toEqual(['lead-skill'])
  })

  it('allows explicit worker session skills after opting out of lead inheritance', async () => {
    const { request } = await workerRequest({ lead: capableLead, inheritLeadTools: false,
      workerSessionOptions: { skills: [workerSkill] } })
    expect(names(request)).toContain('load_skill')
    expect(names(request)).not.toContain('web-search')
    expect(request.system).toContain('worker-skill')
    expect(request.system).not.toContain('lead-skill')
  })

  it.each(['workerTemplate', 'workerFactory'] as const)('keeps %s native tools and skills on opt-out', async key => {
    const { request } = await workerRequest({ inheritLeadTools: false,
      ...key === 'workerTemplate' ? { workerTemplate: capableLead } : { workerFactory: () => capableLead } })
    expect(names(request)).toContain('web-search')
    expect(names(request)).toContain('load_skill')
    expect(request.system).toContain('lead-skill')
  })

  it('explicit empty tools replace a custom definition even with inheritance enabled', async () => {
    const workerTemplate = defineAgent({ id: 'custom', provider: 'test', model: 'scripted',
      instructions: 'Restricted worker.', tools: [write] })
    const { request } = await workerRequest({ workerTemplate, workerSessionOptions: { tools: [] } })
    expect(names(request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
  })

  it.each(['workerTemplate', 'workerFactory'] as const)('keeps %s tools narrow', async key => {
    const definition = defineAgent({ id: 'narrow', provider: 'test', model: 'scripted',
      instructions: 'Use only your supplied tools.', tools: [write] })
    const extra = defineTool({ name: 'search_files', description: 'Search.',
      parameters: { type: 'object' }, execute: () => 'found' })
    const { request } = await workerRequest({ leadSessionOptions: { tools: [extra] },
      ...key === 'workerTemplate' ? { workerTemplate: definition } : { workerFactory: () => definition } })
    expect(names(request)).toEqual(['write_file', 'list_agents', 'get_agent_result', 'send_message'])
  })

  it('excludes lead-only, team/control, and user-input tools before inheritance at any depth', async () => {
    const excluded = ['deploy', 'commit', 'spawn_agent', 'close_agent', 'list_agents', 'get_agent_result', 'send_message',
      'followup_task', 'wait_agents', 'submit_result', 'request_user_input', 'request_user_input_async', 'ask_user']
    const tools = excluded.map(name => defineTool({ name, description: 'Lead only.',
      parameters: { type: 'object' }, execute: () => 'must not run' }))
    tools.push(defineTool({ name: 'custom_question', description: 'Ask person.', awaitsPerson: true,
      parameters: { type: 'object' }, execute: () => 'must not run' }))
    const catalog = new ToolRegistry()
    const { adapter, managed } = setup({ maxDepth: 3, workerTeamTools: false,
      leadOnlyTools: ['deploy', 'commit'], leadSessionOptions: { tools: catalog } })
    try {
      // Host catalogs can gain tools after the lead session has been created.
      tools.forEach(tool => catalog.register(tool))
      const worker = await managed.spawn({ task: 'Inspect only' })
      await managed.awaitWorker(worker.name)
      expect(names(adapter.requests[0]!)).toEqual(['read_file'])
    } finally { await managed.dispose() }
  })

  it.each(['interceptors', 'approvals'] as const)('refuses inheritance without matching lead %s', async key => {
    const policy = key === 'interceptors' ? { interceptors: [{ name: 'guard' }] }
      : { approvals: { request: async () => 'deny' as const } }
    const { adapter, managed } = setup({ leadSessionOptions: policy })
    try {
      await expect(managed.spawn({ task: 'guarded' })).rejects.toThrow(`same ${key}`)
      expect(adapter.requests).toEqual([])
      expect(managed.workers()).toEqual([])
    } finally { await managed.dispose() }
  })

  it('refuses per-worker overrides that replace a shared approval broker', async () => {
    const approvals = { request: async () => 'deny' as const }
    const { managed } = setup({ leadSessionOptions: { approvals }, workerSessionOptions: { approvals },
      workerSessionOptionsFactory: () => ({ approvals: { request: async () => 'allow' as const } }) })
    try { await expect(managed.spawn({ task: 'guarded' })).rejects.toThrow('same approvals') }
    finally { await managed.dispose() }
  })

  it('refuses a different interceptor array even if its names match', async () => {
    const { managed } = setup({ leadSessionOptions: { interceptors: [{ name: 'guard' }] },
      workerSessionOptions: { interceptors: [{ name: 'guard' }] } })
    try { await expect(managed.spawn({ task: 'guarded' })).rejects.toThrow('same interceptors') }
    finally { await managed.dispose() }
  })

  it('executes the shared interceptor and approval broker before an inherited tool', async () => {
    writeExecute.mockClear()
    const before = vi.fn(async () => ({ kind: 'ask' as const }))
    const request = vi.fn(async () => 'deny' as const)
    const policy = { interceptors: [{ name: 'require-approval', before }], approvals: { request } }
    const { adapter, managed } = setup({ leadSessionOptions: { ...policy, tools: [write] },
      workerSessionOptions: policy })
    adapter.attemptTool = 'write_file'
    try {
      const worker = await managed.spawn({ task: 'Try guarded write', writes: ['src'] })
      await managed.awaitWorker(worker.name)
      expect(before).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledOnce()
      expect(writeExecute).not.toHaveBeenCalled()
    } finally { await managed.dispose() }
  })

  it.each(['interceptors', 'approvals'] as const)('preserves base %s when the scoped value is undefined', async key => {
    writeExecute.mockClear()
    const before = vi.fn(async () => ({ kind: 'ask' as const }))
    const request = vi.fn(async () => 'deny' as const)
    const { adapter, managed } = setup({
      workerSessionOptions: { tools: [write], interceptors: [{ name: 'require-approval', before }],
        approvals: { request } },
      workerSessionOptionsFactory: () => ({ [key]: undefined }),
    })
    adapter.attemptTool = 'write_file'
    try {
      const worker = await managed.spawn({ task: 'Try guarded write', writes: ['src'] })
      await managed.awaitWorker(worker.name)
      expect(before).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledOnce()
      expect(writeExecute).not.toHaveBeenCalled()
    } finally { await managed.dispose() }
  })

  it('lets the host supply independent worker policy when inheritance is disabled or replaced', async () => {
    const approvals = { request: async () => 'deny' as const }
    const disabled = await workerRequest({ leadSessionOptions: { approvals }, inheritLeadTools: false })
    expect(names(disabled.request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
    const replaced = await workerRequest({ leadSessionOptions: { approvals },
      workerSessionOptions: { tools: [write] } })
    expect(names(replaced.request)).toEqual(['write_file', 'list_agents', 'get_agent_result', 'send_message'])
  })

  it('honors per-worker overrides and applies role narrowing afterwards', async () => {
    const { request } = await workerRequest({
      workerSessionOptions: { tools: [read, write] },
      workerSessionOptionsFactory: () => ({ tools: [write] }),
      roles: [{ name: 'limited', description: 'Only read.', tools: ['read_file', 'unavailable_tool'] }],
    }, { task: 'Inspect', role: 'limited' })
    expect(names(request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
  })

  it('presets are opt-in and read-only roles fail closed without host-approved tools', async () => {
    const presets = managedAgentRolePresets()
    expect(presets.map(role => role.name)).toEqual(['explorer', 'worker', 'reviewer'])
    const empty = await workerRequest({ roles: presets }, { task: 'Explore', role: 'explorer' })
    expect(names(empty.request)).toEqual(['list_agents', 'get_agent_result', 'send_message'])
    const full = await workerRequest({ roles: presets, leadSessionOptions: { tools: [write] } },
      { task: 'Implement', role: 'worker', writes: ['src'] })
    expect(names(full.request)).toContain('write_file')
  })

  it('explorers retain only host-approved read tools even with full team access requested', async () => {
    const { request } = await workerRequest({
      roles: managedAgentRolePresets({ readOnlyTools: ['read_file'] }),
      leadSessionOptions: { tools: [write] }, workerTeamTools: 'full',
    }, { task: 'Explore', role: 'explorer' })
    expect(names(request)).toEqual(['read_file', 'list_agents', 'get_agent_result', 'send_message'])
  })

  it('rejects an attempted write at execution, not just in the prompt', async () => {
    writeExecute.mockClear()
    const { adapter, managed } = setup({ leadSessionOptions: { tools: [write] },
      roles: managedAgentRolePresets({ readOnlyTools: ['read_file'] }) })
    adapter.attemptTool = 'write_file'
    try {
      const worker = await managed.spawn({ task: 'Explore', role: 'explorer' })
      await managed.awaitWorker(worker.name)
      expect(writeExecute).not.toHaveBeenCalled()
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('no tool named')
    } finally { await managed.dispose() }
  })

  it('executes an inherited application tool using the original host implementation', async () => {
    writeExecute.mockClear()
    const { adapter, managed } = setup({ leadSessionOptions: { tools: [write] } })
    adapter.attemptTool = 'write_file'
    try {
      const worker = await managed.spawn({ task: 'Implement', writes: ['src'] })
      await managed.awaitWorker(worker.name)
      expect(writeExecute).toHaveBeenCalledOnce()
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('written')
    } finally { await managed.dispose() }
  })

  it('applies narrowing and worker instructions to custom factories too', async () => {
    const { request } = await workerRequest({
      roles: managedAgentRolePresets({ readOnlyTools: ['read_file'] }),
      workerFactory: () => defineAgent({ id: 'custom', provider: 'test', model: 'scripted',
        instructions: 'Custom domain instructions.', tools: [read, write],
        nativeTools: [{ type: 'native', name: 'web-search' }] }),
    }, { task: 'Review', role: 'reviewer' })
    expect(names(request)).toEqual(['read_file', 'list_agents', 'get_agent_result', 'send_message'])
    expect(request.system).toContain('Custom domain instructions.')
    expect(request.system).toContain('Review independently.')
    expect(request.system).toContain('Do not revert others\' edits')
  })

  it('reviewers force fresh context even when fork is requested or configured', async () => {
    const { adapter, managed } = setup({ defaultSpawnContext: 'fork',
      roles: managedAgentRolePresets({ readOnlyTools: ['read_file'] }) })
    try {
      await managed.run('lead-only secret finding')
      const worker = await managed.spawn({ task: 'Review fixture', role: 'reviewer', context: 'fork' })
      await managed.awaitWorker(worker.name)
      expect(worker.context).toBe('fresh')
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('lead-only secret finding')
    } finally { await managed.dispose() }
  })
})

describe('managed delegation depth guard', () => {
  it('filters arbitrary control lists by name while retaining collection tools', () => {
    const controls = [{ name: 'spawn_agent', custom: true }, { name: 'join', custom: true }, { name: 'wait_agents' }]
    expect(filterToolsByDepth(controls, { maxDepth: 0 })).toEqual(controls.slice(1))
    expect(filterToolsByDepth(controls, { maxDepth: 1 })).toBe(controls)
    expect(filterToolsByDepth(controls, { maxDepth: 1 }, true)).toEqual(controls.slice(1))
  })
  it.each([{ depth: 0, maxDepth: 0 }, { depth: 2, maxDepth: 2 }, { depth: 3, maxDepth: 2 }])(
    'hides spawning and rejects host spawn at $depth/$maxDepth', async limits => {
      const spawn = defineTool({ name: 'spawn_agent', description: 'Host spawner.',
        parameters: { type: 'object' }, execute: () => 'started' })
      const { adapter, managed } = setup({ ...limits, leadSessionOptions: { tools: [spawn] } })
      try {
        await managed.run('work directly')
        expect(names(adapter.requests[0]!)).not.toContain('spawn_agent')
        expect(adapter.requests[0]!.system).toContain('Do the work directly; do not spawn agents.')
        expect(adapter.requests[0]!.system).toContain('synthesize the caller-requested result')
        expect(adapter.requests[0]!.system).toContain('Do not present a final answer before needed reports arrive')
        expect(adapter.requests[0]!.system).toContain('Wait sparingly')
        await expect(managed.spawn({ task: 'too deep' })).rejects.toThrow('depth limit reached')
        expect(managed.workers()).toEqual([])
      } finally { await managed.dispose() }
    },
  )

  it('hides inherited spawn tools from workers at the default depth limit', async () => {
    const spawn = defineTool({ name: 'spawn_agent', description: 'Host spawner.',
      parameters: { type: 'object' }, execute: () => 'started' })
    const { request } = await workerRequest({ workerSessionOptions: { tools: [read, spawn] } })
    expect(names(request)).not.toContain('spawn_agent')
    expect(request.system).not.toContain('Delegation depth limit reached')
  })

  it('allows a host-owned spawn hook below the worker depth limit', async () => {
    const spawn = defineTool({ name: 'spawn_agent', description: 'Host spawner.',
      parameters: { type: 'object' }, execute: () => 'started' })
    const { request } = await workerRequest({ maxDepth: 2, workerSessionOptions: { tools: [spawn] } })
    expect(names(request)).toContain('spawn_agent')
    expect(request.system).not.toContain('Delegation depth limit reached')
  })

  it.each([{ depth: -1 }, { maxDepth: 0.5 }, { maxDepth: Number.POSITIVE_INFINITY }])(
    'rejects invalid depth options %j', limits => {
      expect(() => setup(limits)).toThrow('must be a non-negative integer')
    },
  )
})
