import { describe, expect, it } from 'vitest'
import { runMcpRoundTrips } from '../../test-human/mcp/runner.ts'

describe('MCP human round-trip workload', () => {
  it('mixes concurrent success and remote errors across repeated lifecycles', async () => {
    const result = await runMcpRoundTrips({ requests: 12, parallel: 6, cycles: 3 })
    expect(result).toMatchObject({ requests: 36, passed: 36, expectedErrors: 18, unexpected: [] })
    expect(result.cycles).toHaveLength(3)
    for (const cycle of result.cycles) {
      expect(cycle.lifecycle).toEqual(['connecting', 'ready', 'closed'])
      expect(cycle.discoveredTools).toEqual(['mcp__warehouse__quote_inventory'])
      expect(cycle.protocolVersion).toBe('2025-11-25')
    }
  })
})
