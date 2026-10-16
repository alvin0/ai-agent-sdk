import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { captureSingleSurface, captureSurface } from './team-surface-capture.ts'
import { estimateTextTokens } from '../../packages/core/src/agent/tool/output-budget/token-budget.ts'
import { DISCLOSED_TEAM_GUIDANCE } from '../../packages/core/src/agent/team/managed-lazy-tools.ts'

type Surfaces = Record<string, Awaited<ReturnType<typeof captureSurface>>>
type FrozenView = { system: number; tools: number; total: number; estimatedTokens: number; sha256: string }
// Preserve pre-lazy captures from 5b81eda; combined holds the merged eager/legacy contract.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/team-lazy-surfaces.json', import.meta.url), 'utf8')) as {
  before: Record<string, FrozenView[]>
  combined: Record<string, FrozenView[]>
}
const hash = (view: Surfaces[string][number]) => createHash('sha256').update(JSON.stringify(view)).digest('hex')

function surfaceSize(view: Surfaces[string][number]) {
  const catalog = JSON.stringify(view.tools)
  return { system: view.system.length, tools: catalog.length, total: view.system.length + catalog.length,
    estimatedTokens: estimateTextTokens(view.system + catalog),
    toolNames: view.tools.map(tool => tool.name), sha256: hash(view) }
}

describe('managed model surface size', () => {
  it('snapshots sizes, tool names and exact surface hashes', async () => {
    const after: Surfaces = {
      single: await captureSingleSurface(),
      lean: await captureSurface(),
      fullWorker: await captureSurface({ workerTeamTools: 'full' }),
      eager: await captureSurface({ progressiveToolDisclosure: false }),
      eagerFullWorker: await captureSurface({ progressiveToolDisclosure: false, workerTeamTools: 'full' }),
      legacy: await captureSurface({ modelToolSurface: 'legacy' }),
      collaboration: await captureSurface({ collaboration: true }),
    }
    const sizes = Object.fromEntries(Object.entries(after).map(([name, views]) => [name, views.map(surfaceSize)]))
    expect({ after: sizes,
      retainedGuidanceChars: DISCLOSED_TEAM_GUIDANCE.length,
      retainedGuidanceEstimatedTokens: estimateTextTokens(DISCLOSED_TEAM_GUIDANCE),
    }).toMatchSnapshot()
    expect({ system: after.lean![0]!.system, guidance: DISCLOSED_TEAM_GUIDANCE })
      .toMatchSnapshot('lead prompt and disclosed guidance')
    const total = (view: Surfaces[string][number]) => view.system.length + JSON.stringify(view.tools).length
    const batch = (view: Surfaces[string][number]) =>
      JSON.stringify(view.tools.filter(tool => tool.name === 'spawn_agents')).length - 2
    // The new initial batch verb has a separate 1,200-character budget. Keep lazy's
    // original control-size guard and the branch's complete eager/legacy guard.
    expect(total(after.lean![0]!) - batch(after.lean![0]!)).toBeLessThan(fixture.before.lean![0]!.total * 0.35)
    expect(batch(after.lean![0]!)).toBeLessThanOrEqual(1200)
    expect(total(after.eager![0]!)).toBeLessThan(total(after.legacy![0]!) * 0.7)
    expect(total(after.eager![0]!) - batch(after.eager![0]!))
      .toBeLessThan((total(after.legacy![0]!) - batch(after.legacy![0]!)) * 0.65)
    expect(total(after.eager![1]!)).toBeLessThan(total(after.legacy![1]!) * 0.6)
    expect(total(after.lean![1]!)).toBeLessThan(fixture.before.lean![1]!.total)
    expect(total(after.fullWorker![1]!)).toBeLessThan(fixture.before.fullWorker![1]!.total * 0.95)
    expect(after.lean![0]!.system).toBe(after.lean![2]!.system)
    expect(after.lean![2]!.tools.slice(0, 2)).toEqual(after.lean![0]!.tools)
    // Lead cost guidance intentionally changes on every surface. Workers retain
    // the frozen integration contract; current lead text is pinned above.
    for (const name of ['legacy', 'eager', 'eagerFullWorker']) {
      expect(hash(after[name]![1]!)).toBe(fixture.combined[name]![1]!.sha256)
    }
  })
})
