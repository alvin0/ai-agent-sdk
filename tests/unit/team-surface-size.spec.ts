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
// Frozen directly from integration 4cc1c91, independent of updatable snapshots.
const initial = JSON.parse(readFileSync(
  new URL('../fixtures/team-progress-initial-surfaces.json', import.meta.url), 'utf8')) as Record<string, unknown>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Frozen r4 lead catalogs, including spawn_agent/spawn_agents schemas and descriptions.
// System text may change; snapshot updates must not silently change tool JSON.
const leadToolHashes = {
  leanInitial: 'ba91447ebfafa208b43b7f50586132c80174005c2570a5ab9d1bde514d1e41a4',
  leanDisclosed: 'c30e44408de10684f279670ad47cb09c23a5f4a4f6ae4b56f9184e9bf68f56f0',
  eager: '28aa1b2b0e6340f3b0bc5673322ab29cbccd7c6a2ef720b8a5fada4e5fa91ed4',
  legacy: 'a773fc9864ed37e9f8d64cef9e5561e0bc2e079c977fd14ef80b39eec86f1761',
  collaboration: '056a0973d4df25d3af88fef329769e455c0f1be531b13114f4fcfae6a5ac1db7',
}

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
    for (const [name, views] of Object.entries(after)) {
      expect(surfaceSize(views[0]!)).toEqual(initial[name])
      expect(views[0]!.tools.some(tool => tool.name === 'progress_updates')).toBe(false)
    }
    const baselineTools = (view: Surfaces[string][number]) =>
      view.tools.filter(tool => tool.name !== 'progress_updates')
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
    for (const name of ['lean', 'fullWorker']) {
      expect(hash(after[name]![0]!.tools)).toBe(leadToolHashes.leanInitial)
      expect(hash(baselineTools(after[name]![2]!))).toBe(leadToolHashes.leanDisclosed)
    }
    for (const name of ['eager', 'eagerFullWorker', 'legacy', 'collaboration'] as const) {
      const expected = leadToolHashes[name === 'eagerFullWorker' ? 'eager' : name]
      expect(hash(after[name]![0]!.tools)).toBe(expected)
      expect(hash(baselineTools(after[name]![2]!))).toBe(expected)
    }
    expect(hash(after.lean![0]!)).toBe('36fe0d31ff7c25fc18882ebe0e138d127e5dc18572eaf4d21a86007e01dccbda')
    expect(JSON.stringify(after.lean![2]!.tools.find(tool => tool.name === 'progress_updates')).length)
      .toBeLessThan(600)
    // Workers retain the frozen integration contract; only lead system text may differ.
    for (const name of ['legacy', 'eager', 'eagerFullWorker']) {
      expect(hash(after[name]![1]!)).toBe(fixture.combined[name]![1]!.sha256)
    }
  })
})
