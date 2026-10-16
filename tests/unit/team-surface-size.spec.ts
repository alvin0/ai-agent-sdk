import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { captureSingleSurface, captureSurface } from './team-surface-capture.ts'
import { estimateTextTokens } from '../../packages/core/src/agent/tool/output-budget/token-budget.ts'
import { DISCLOSED_TEAM_GUIDANCE } from '../../packages/core/src/agent/team/managed-lazy-tools.ts'

type Surfaces = Record<string, Awaited<ReturnType<typeof captureSurface>>>
const path = new URL('../fixtures/team-lazy-surfaces.json', import.meta.url)
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { before: Surfaces; after: Surfaces }

describe('managed model surface size', () => {
  it('snapshots exact catalogs, prompts and per-call character/token estimates', async () => {
    const after: Surfaces = {
      single: await captureSingleSurface(),
      lean: await captureSurface(),
      fullWorker: await captureSurface({ workerTeamTools: 'full' }),
      eager: await captureSurface({ progressiveToolDisclosure: false }),
      legacy: await captureSurface({ modelToolSurface: 'legacy' }),
      collaboration: await captureSurface({ collaboration: true }),
    }
    if (process.env.UPDATE_TEAM_SURFACES === '1') {
      writeFileSync(path, JSON.stringify({ ...fixture, after }, null, 2) + '\n')
    } else expect(after).toEqual(fixture.after)
    const sizes = (surfaces: Surfaces) => Object.fromEntries(Object.entries(surfaces).map(([name, views]) =>
      [name, views.map(({ system, tools }) => {
        const catalog = JSON.stringify(tools)
        return { system: system.length, tools: catalog.length, total: system.length + catalog.length,
          estimatedTokens: estimateTextTokens(system + catalog) }
      })]))
    expect({ before: sizes(fixture.before), after: sizes(after),
      retainedGuidanceChars: DISCLOSED_TEAM_GUIDANCE.length,
      retainedGuidanceEstimatedTokens: estimateTextTokens(DISCLOSED_TEAM_GUIDANCE),
    }).toMatchSnapshot()
    const total = (view: Surfaces[string][number]) => view.system.length + JSON.stringify(view.tools).length
    expect(total(after.lean![0]!)).toBeLessThan(total(fixture.before.lean![0]!) * 0.35)
    expect(total(after.lean![1]!)).toBeLessThan(total(fixture.before.lean![1]!))
    expect(total(after.fullWorker![1]!)).toBeLessThan(total(fixture.before.fullWorker![1]!) * 0.9)
    expect(after.lean![0]!.system).toBe(after.lean![2]!.system)
    expect(after.lean![2]!.tools.slice(0, 1)).toEqual(after.lean![0]!.tools)
    expect(after.lean![2]!.tools).toEqual(after.eager![0]!.tools)
    expect(after.legacy).toEqual(fixture.before.legacy)
  })
})
