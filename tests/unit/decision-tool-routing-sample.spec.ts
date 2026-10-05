import { describe, expect, it } from 'vitest'
import { scenarios, golden } from '../../samples/decision-tool-routing/cases.ts'
import { assess, createWorkspace, executeTool, expectedNext, oracle, plans, requiredSources, type Scenario, type Selection, type ToolName, type Workspace } from '../../samples/decision-tool-routing/domain.ts'
import { grade, parseReport, publicState, runWorkflow, safeErrorDetail, stopsBenchmark, type Recommendation, type Selector, type Writer } from '../../samples/decision-tool-routing/workflow.ts'

// Workspace comes from domain; selectors below are scripted test doubles, never benchmark arms.
function referenceSelector(s: Scenario): Selector {
  const shadow = createWorkspace()
  return {
    async chooseTool() {
      const choice = expectedNext(s, shadow)[0]!
      executeTool(s, shadow, choice, choice === 'draft_recommendation' ? oracle(s)[0] : undefined)
      return { choice, model: 'offline-fixture' }
    },
    async choosePlan() { return { choice: oracle(s)[0]!, model: 'offline-fixture' } },
  }
}
function memo(s: Scenario, w: Workspace): Recommendation {
  const selected = w.assessments!.find(p => p.id === w.selection)
  return {
    recommendation: w.selection!, status: selected ? 'propose' : 'escalate',
    cost: selected?.cost ?? null, criticalOnTime: selected?.criticalOnTime ?? null, unmetUnits: selected?.unmetUnits ?? null,
    summary: 'This analysis uses the simulated delivery evidence and all hard operating constraints. No order was placed. The proposal remains subject to operator review.',
    evidenceIds: [...requiredSources(s), 'simulate_plans', 'draft_recommendation'],
    rejectedPlans: w.assessments!.filter(p => p.id !== w.selection && (p.violations.length > 0 || (selected && p.cost > selected.cost)))
      .slice(0, 2).map(p => ({ id: p.id, reason: p.violations[0] ?? 'higher_cost' })),
  }
}
const referenceWriter = (s: Scenario): Writer => async state => {
  const data = state as { observations: Workspace['observations'] }
  const w = createWorkspace()
  w.observations = data.observations
  w.assessments = (data.observations.simulate_plans as { assessments: Workspace['assessments'] }).assessments!
  w.selection = (data.observations.draft_recommendation as { selection: Selection }).selection
  return { report: memo(s, w), model: 'offline-fixture' }
}
describe('decision tool-routing sample benchmark', () => {
  it.each(scenarios)('$id oracle agrees with independently reviewed golden labels', s => {
    expect(oracle(s)).toEqual([golden[s.id]])
  })
  it.each(scenarios)('$id complete workflow accepts valid plans and evidence', async s => {
    const result = await runWorkflow(s, referenceSelector(s), referenceWriter(s), { signal: new AbortController().signal })
    expect(grade(s, result)).toMatchObject({ pass: true, toolAccuracy: 1, planAccuracy: 1, extraToolCalls: 0 })
    expect(result.workspace.selection).toBe(golden[s.id])
  })
  it('uses a set of acceptable next fact reads, rather than one canonical order', () => {
    const s = scenarios[0]!, w = createWorkspace()
    expect(expectedNext(s, w)).toEqual(expect.arrayContaining(['read_inventory', 'read_demand', 'read_policy', 'read_suppliers', 'read_lanes']))
    executeTool(s, w, 'read_policy')
    expect(expectedNext(s, w)).not.toContain('read_policy')
  })
  it('does not leak hidden scenario data or oracle labels to selector state', () => {
    const s = scenarios[2]!, state = JSON.stringify(publicState(s, createWorkspace()))
    expect(state).not.toContain('standardCertified')
    expect(state).not.toContain('standardCost')
    expect(state).not.toContain('expected')
    expect(state).not.toContain('P3')
  })
  it('cannot bypass temperature investigation with the on-hand inventory sum', () => {
    const s = scenarios[4]!, w = createWorkspace()
    for (const name of ['read_inventory', 'read_demand', 'read_policy'] as const) executeTool(s, w, name)
    expect(executeTool(s, w, 'build_plans')).toMatchObject({ ok: false, output: { missing: ['read_temperature'] } })
    executeTool(s, w, 'read_temperature')
    expect(executeTool(s, w, 'build_plans').ok).toBe(true)
    expect(w.candidates?.map(p => p.id)).toEqual(['P0'])
    expect(requiredSources(s)).not.toContain('read_suppliers')
  })
  it('accounts for reserved stock, donor reserve and separate delivery deadlines', () => {
    const s = scenarios[0]!
    expect(assess(s, plans[1]!)).toMatchObject({ violations: ['reserve_floor'] })
    expect(assess(s, plans[2]!)).toMatchObject({ criticalOnTime: 20, violations: ['critical_deadline'] })
    expect(assess(s, plans[4]!)).toMatchObject({ cost: 520, criticalOnTime: 40, deliveredOnTime: 60, violations: [] })
    const changed = structuredClone(s); changed.lanes.transferStock = 50
    expect(assess(changed, plans[5]!)).toMatchObject({ cost: 300, violations: [] })
  })
  it('accepts all minimum-cost ties without forcing a plan ID', () => {
    const s = structuredClone(scenarios[0]!); s.demand.critical = 20; s.suppliers.expressCost = 200
    expect(oracle(s)).toEqual(['P2', 'P3', 'P4'])
  })
  it('rejects an infeasible model proposal without silently choosing the oracle', () => {
    const s = scenarios[2]!, w = createWorkspace()
    for (const name of [...requiredSources(s), 'build_plans', 'simulate_plans'] as const) executeTool(s, w, name as keyof typeof w.observations)
    expect(executeTool(s, w, 'draft_recommendation', 'P2')).toMatchObject({ ok: false, output: { error: 'INVALID_PROPOSAL' } })
    expect(w.selection).toBeUndefined()
    expect(executeTool(s, w, 'finish').ok).toBe(false)
    expect(executeTool(s, w, 'draft_recommendation', 'escalate').ok).toBe(false)
  })
  it('bounds repeated premature finish choices and never calls the writer', async () => {
    const s = scenarios[0]!
    let writerCalls = 0
    const selector: Selector = {
      async chooseTool() { return { choice: 'finish', model: 'offline-fixture' } },
      async choosePlan() { throw new Error('Unexpected plan call') },
    }
    const run = await runWorkflow(s, selector, async () => { writerCalls++; throw new Error('Unexpected writer') }, { signal: new AbortController().signal, maxSteps: 3 })
    expect(run.failure).toBe('STEP_LIMIT')
    expect(run.workspace.trace).toHaveLength(3)
    expect(grade(s, run).pass).toBe(false)
    expect(writerCalls).toBe(0)
  })
  it('blocks a forbidden action and still counts the attempt as an analysis-only failure', async () => {
    const s = scenarios[7]!, reference = referenceSelector(s)
    let first = true
    const selector: Selector = { ...reference, async chooseTool(state, signal) {
      if (first) { first = false; return { choice: 'place_order', model: 'offline-fixture' } }
      return reference.chooseTool(state, signal)
    } }
    const run = await runWorkflow(s, selector, referenceWriter(s), { signal: new AbortController().signal })
    expect(run.workspace.trace[0]).toMatchObject({ ok: false, output: { missing: ['ANALYSIS_ONLY'] } })
    expect(grade(s, run)).toMatchObject({ pass: false, checks: { outcomeCorrect: true, analysisOnly: false } })
  })
  it('fails grade for fabricated costs, unknown citations and inaccurate rejected-plan reasons', async () => {
    const s = scenarios[0]!, run = await runWorkflow(s, referenceSelector(s), referenceWriter(s), { signal: new AbortController().signal })
    run.report!.cost = 1
    run.report!.evidenceIds.push('hidden_oracle')
    run.report!.rejectedPlans = [{ id: 'P3', reason: 'cold_chain' }, { id: 'P4', reason: 'budget' }]
    expect(grade(s, run)).toMatchObject({ pass: false, checks: { factsCorrect: false, evidenceComplete: false, rejectionFactsCorrect: false } })
  })
  it('rejects repeated draft tools before spending another nested plan-selection call', async () => {
    const s = scenarios[3]!, sequence = [...requiredSources(s), 'build_plans', 'simulate_plans', 'draft_recommendation']
    let next = 0, planCalls = 0
    const selector: Selector = {
      async chooseTool() { return { choice: (sequence[next++] ?? 'draft_recommendation') as ToolName, model: 'offline-fixture' } },
      async choosePlan() { planCalls++; return { choice: 'escalate', model: 'offline-fixture' } },
    }
    const run = await runWorkflow(s, selector, referenceWriter(s), { signal: new AbortController().signal, maxSteps: 12 })
    expect(run.failure).toBe('STEP_LIMIT')
    expect(run.workspace.selection).toBe('escalate')
    expect(planCalls).toBe(1)
    expect(run.workspace.trace.at(-1)).toMatchObject({ ok: false, output: { missing: ['ALREADY_COMPLETED'] } })
  })
  it('rejects malformed report output and preserves safe machine codes only', () => {
    expect(() => parseReport({ recommendation: 'P4', cost: Number.NaN })).toThrow('Invalid report')
    expect(safeErrorDetail(new Error('secret-api-key=should-not-be-logged'))).toBeUndefined()
    expect(safeErrorDetail(new Error('Probabilities must sum to one'))).toBe('Probabilities must sum to one')
    expect(stopsBenchmark('MALFORMED_RESPONSE')).toBe(false)
    expect(stopsBenchmark('AUTH')).toBe(true)
  })
})
