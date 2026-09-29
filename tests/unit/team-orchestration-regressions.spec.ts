import { describe, expect, it } from 'vitest'
import * as core from '@alvin0/ai-agent-sdk-core'
import * as agent from '@alvin0/ai-agent-sdk-core/agent'
import { CASES, runCase } from '../../test-human/multi-agent/conformance.ts'

describe('managed orchestration public-boundary regressions', () => {
  it.each(CASES)('%s', async id => {
    const result = await runCase({ core, agent }, id)
    expect(result.observed).not.toHaveProperty('harnessError')
    expect(result.passed, JSON.stringify(result.observed)).toBe(true)
  })
})
