import { describe, expect, it } from 'vitest'
import { buildDelegationStrategy } from '../../packages/core/src/agent/team/managed-controls.ts'
import { DISCLOSED_TEAM_GUIDANCE } from '../../packages/core/src/agent/team/managed-lazy-tools.ts'
import { captureSurface } from './team-surface-capture.ts'
import { names, setup } from '../helpers/managed-team.ts'

const threshold = 'many independent items that exceed one context or need many sequential steps'

describe('delegation cost guidance', () => {
  it.each([
    {}, { progressiveToolDisclosure: false }, { modelToolSurface: 'legacy' as const }, { collaboration: true },
  ])('keeps local work, one worker and volume fan-out distinct: %j', async options => {
    const [lead] = await captureSurface(options)
    expect(lead!.system).toContain('small or sequential')
    expect(lead!.system).toContain('synthesis cost')
    expect(lead!.system).toContain('fresh-context check')
    expect(lead!.system).toContain(threshold)
    expect(lead!.system).not.toContain('Use the team proactively')
    expect(lead!.system).not.toContain('do not read bulk data yourself before delegating')
    const single = lead!.tools.find(tool => tool.name === 'spawn_agent')!
    const batch = lead!.tools.find(tool => tool.name === 'spawn_agents')!
    if (!('parameters' in single) || !('parameters' in batch)) throw new Error('Expected function tools')
    expect(single.description).toContain('one worthwhile side task or fresh-context check')
    expect(batch.description).toContain(threshold)
    expect(batch.description).toContain('Otherwise work directly or use spawn_agent')
    expect(batch.description).toContain('No dependencies or peer waits on queued tasks')
    // Keep single-item replay/host compatibility: strategy is guidance, not admission policy.
    expect(batch.parameters).toMatchObject({ properties: { tasks: { minItems: 1 } } })
  })

  it('retains application tools first and immediate batch access under lazy disclosure', async () => {
    const { adapter, managed } = setup({ modelToolSurface: 'lean' })
    try {
      await managed.run('Inspect the scope.')
      expect(names(adapter.requests[0]!)).toEqual(['read_file', 'spawn_agent', 'spawn_agents'])
      const catalog = managed.lead.effectiveCatalog()!
      expect(catalog.names()).toEqual(names(adapter.requests[0]!))
      expect(catalog.has('spawn_agents')).toBe(true)
      expect(catalog.get('spawn_agents')).toBeDefined()
      expect(catalog.has('wait_agents')).toBe(false)
      expect(managed.workers()).toHaveLength(0)
    } finally { await managed.dispose(); await managed.team.dispose() }
  })

  it('does not turn a first delegation or spare capacity into a request for more workers', () => {
    expect(DISCLOSED_TEAM_GUIDANCE).toContain('Do remaining small work directly')
    expect(DISCLOSED_TEAM_GUIDANCE).toContain(threshold)
    expect(DISCLOSED_TEAM_GUIDANCE).toContain('limits, not targets')
    expect(DISCLOSED_TEAM_GUIDANCE).toContain('Once justified, plan partitions before reading bulk inputs')
    expect(DISCLOSED_TEAM_GUIDANCE).toContain('returns only new results')
    expect(DISCLOSED_TEAM_GUIDANCE).toContain('Do not poll or repeat short waits')
    for (const mode of ['explicit', 'proactive'] as const) {
      expect(buildDelegationStrategy(mode)).toContain(threshold)
      expect(buildDelegationStrategy(mode)).toContain('startup and synthesis cost')
    }
    expect(buildDelegationStrategy('explicit'))
      .toContain('Delegate only when the user or host instructions explicitly ask')
    expect(() => buildDelegationStrategy('invalid' as 'proactive')).toThrow('invalid managed delegationMode')
  })
})
