import { describe, expect, it } from 'vitest'
import * as core from '@alvin0/ai-agent-sdk-core'
import * as agent from '@alvin0/ai-agent-sdk-core/agent'
import { CASES, runCase } from '../../test-human/multi-agent/conformance.ts'

describe('managed orchestration public-boundary regressions', () => {
  it.each(CASES)('%s', async id => {
    // This conformance case asserts the historical vocabulary. Keep it as an
    // explicit compatibility gate; lean access is covered by team-lean-surface.
    const sdk = id === 'host-controls-worker-tools' ? { core, agent: { ...agent,
      createManagedAgentTeam: (options: agent.ManagedAgentTeamOptions) =>
        agent.createManagedAgentTeam({ ...options, modelToolSurface: 'legacy' }),
    } } : { core, agent }
    const result = await runCase(sdk, id)
    expect(result.observed).not.toHaveProperty('harnessError')
    expect(result.passed, JSON.stringify(result.observed)).toBe(true)
  })
})
