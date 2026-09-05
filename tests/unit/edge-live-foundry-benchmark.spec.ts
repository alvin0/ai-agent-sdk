import { describe, expect, it } from 'vitest'
import {
  foundryBenchmarkInvariants, isFoundryBenchmark,
} from '../../test-human/edge-chat/live/foundry-benchmark.ts'

describe('Foundry deep-research acceptance', () => {
  it('activates only for the dedicated prompt fixture', () => {
    expect(isFoundryBenchmark('/tmp/microsoft-foundry-agent-service.vi.md')).toBe(true)
    expect(isFoundryBenchmark('/tmp/another-task.md')).toBe(false)
  })

  it('rejects a long but structurally incomplete report without supplying answers', () => {
    const invariants = foundryBenchmarkInvariants('# Executive Summary\nA'.repeat(5_000))
    expect(invariants).toHaveLength(4)
    expect(invariants.every(invariant => !invariant.passed)).toBe(true)
  })
})
