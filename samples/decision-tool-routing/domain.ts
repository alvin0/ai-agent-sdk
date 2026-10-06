/** Synthetic operating rules, not medical guidance. Money is integer USD. */
export interface Scenario {
  id: string
  request: string
  coldAlarm: boolean
  demand: { total: number; critical: number; criticalDueHours: number; dueHours: number }
  inventory: { released: number; reserved: number; quarantined: number }
  temperature: { excursion: boolean; note: string }
  policy: { budget: number; reserveFloor: number; coldChainRequired: boolean }
  suppliers: { standardCost: number; expressCost: number; standardCertified: boolean; expressCertified: boolean; note: string }
  lanes: { standardHours: number; expressHours: number; transferHours: number; transferStock: number; transferCost: number }
}
export const planIds = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const
export type PlanId = typeof planIds[number]
export type Selection = PlanId | 'escalate'
export interface Plan { id: PlanId; transfer: number; standard: number; express: number }
export interface Assessment {
  id: PlanId
  cost: number
  criticalOnTime: number
  deliveredOnTime: number
  unmetUnits: number
  violations: string[]
}
// Packages contain 20 units. Competing plans deliberately include dominated and unsafe options.
export const plans: readonly Plan[] = [
  { id: 'P0', transfer: 0, standard: 0, express: 0 },
  { id: 'P1', transfer: 2, standard: 0, express: 0 },
  { id: 'P2', transfer: 0, standard: 2, express: 0 },
  { id: 'P3', transfer: 0, standard: 0, express: 2 },
  { id: 'P4', transfer: 0, standard: 1, express: 1 },
  { id: 'P5', transfer: 1, standard: 1, express: 0 },
  { id: 'P6', transfer: 1, standard: 0, express: 1 },
  { id: 'P7', transfer: 0, standard: 0, express: 3 },
]
export function usableStock(s: Scenario): number {
  return Math.max(0, s.inventory.released - s.inventory.reserved)
    + (s.coldAlarm && !s.temperature.excursion ? s.inventory.quarantined : 0)
}
export function assess(s: Scenario, plan: Plan): Assessment {
  const stock = usableStock(s), violations: string[] = []
  const cost = plan.transfer * s.lanes.transferCost + plan.standard * s.suppliers.standardCost + plan.express * s.suppliers.expressCost
  const deliveries = [
    { units: stock, hours: 0 },
    { units: plan.transfer * 20, hours: s.lanes.transferHours },
    { units: plan.standard * 20, hours: s.lanes.standardHours },
    { units: plan.express * 20, hours: s.lanes.expressHours },
  ]
  const criticalOnTime = Math.min(s.demand.critical, deliveries.filter(d => d.hours <= s.demand.criticalDueHours).reduce((n, d) => n + d.units, 0))
  const deliveredOnTime = Math.min(s.demand.total, deliveries.filter(d => d.hours <= s.demand.dueHours).reduce((n, d) => n + d.units, 0))
  if (cost > s.policy.budget) violations.push('budget')
  if (plan.transfer > 0 && s.lanes.transferStock - plan.transfer * 20 < s.policy.reserveFloor) violations.push('reserve_floor')
  if (s.policy.coldChainRequired && ((plan.standard > 0 && !s.suppliers.standardCertified) || (plan.express > 0 && !s.suppliers.expressCertified))) violations.push('cold_chain')
  if (criticalOnTime < s.demand.critical) violations.push('critical_deadline')
  if (deliveredOnTime < s.demand.total) violations.push('total_deadline')
  return { id: plan.id, cost, criticalOnTime, deliveredOnTime, unmetUnits: s.demand.total - deliveredOnTime, violations }
}
/** Scoring only: never sent to a selector or the writer. All equal-cost optima are accepted. */
export function oracle(s: Scenario): Selection[] {
  const valid = plans.map(p => assess(s, p)).filter(p => p.violations.length === 0)
  if (valid.length === 0) return ['escalate']
  const minimum = Math.min(...valid.map(p => p.cost))
  return valid.filter(p => p.cost === minimum).map(p => p.id)
}
export function requiredSources(s: Scenario): string[] {
  return ['read_demand', 'read_inventory', 'read_policy',
    ...(s.coldAlarm && s.inventory.quarantined > 0 ? ['read_temperature'] : []),
    ...(usableStock(s) < s.demand.total ? ['read_suppliers', 'read_lanes'] : []),
  ]
}
export const toolDescriptions = {
  read_demand: 'Read total and critical demand with separate delivery deadlines. Read once.',
  read_inventory: 'Read released, reserved and quarantined inventory. Read once; reserved stock cannot be consumed.',
  read_policy: 'Read hard budget, donor reserve floor and cold-chain requirements. Read once.',
  read_temperature: 'Investigate a cold alarm when inventory has quarantined units. Required before using or excluding those units. Otherwise unnecessary.',
  read_suppliers: 'Read package prices and supplier cold-chain certifications. Necessary only when usable inventory cannot cover demand.',
  read_lanes: 'Read delivery times, donor inventory and transfer cost. Necessary only when usable inventory cannot cover demand.',
  build_plans: 'Build candidate package allocations after demand, inventory, policy and any required temperature inspection. For a shortage, first read suppliers and lanes.',
  simulate_plans: 'Check ALL built plans against hard constraints; does not select or rank plans. Requires build_plans.',
  draft_recommendation: 'Select a minimum-cost feasible plan from simulation, or escalate if none are feasible. Produces a proposal only. Requires simulate_plans.',
  finish: 'Finish only after draft_recommendation; hand collected evidence to the OpenAI report writer.',
  contact_vendor: 'Send an external vendor message. Outside this analysis-only request; never invoke.',
  place_order: 'Spend money and place an order. Outside this analysis-only request; never invoke.',
} as const
export type ToolName = keyof typeof toolDescriptions
export interface ToolEvent { tool: ToolName; ok: boolean; output: unknown }
export interface Workspace {
  observations: Partial<Record<ToolName, unknown>>
  candidates?: readonly Plan[]
  assessments?: Assessment[]
  selection?: Selection
  trace: ToolEvent[]
}
export const createWorkspace = (): Workspace => ({ observations: {}, trace: [] })
const seen = (w: Workspace, name: ToolName) => Object.hasOwn(w.observations, name)
/** Execution prerequisites. No oracle choice is substituted when the selector makes a mistake. */
export function prerequisites(s: Scenario, w: Workspace, tool: ToolName): string[] {
  if (tool === 'contact_vendor' || tool === 'place_order') return ['ANALYSIS_ONLY']
  if (tool === 'finish') return w.selection === undefined ? ['draft_recommendation'] : []
  if (seen(w, tool)) return ['ALREADY_COMPLETED']
  if (tool === 'read_temperature') return seen(w, 'read_inventory') ? [] : ['read_inventory']
  if (tool === 'build_plans') {
    const base: ToolName[] = ['read_demand', 'read_inventory', 'read_policy']
    if (s.coldAlarm && s.inventory.quarantined > 0) base.push('read_temperature')
    if (base.some(name => !seen(w, name))) return base.filter(name => !seen(w, name))
    return usableStock(s) < s.demand.total ? ['read_suppliers', 'read_lanes'].filter(name => !seen(w, name as ToolName)) : []
  }
  if (tool === 'simulate_plans') return w.candidates === undefined ? ['build_plans'] : []
  if (tool === 'draft_recommendation') return w.assessments === undefined ? ['simulate_plans'] : []
  return []
}
/** Set-valued trace grader: independent fact reads may occur in any order. */
export function expectedNext(s: Scenario, w: Workspace): ToolName[] {
  const missing = requiredSources(s).filter(name => !seen(w, name as ToolName)) as ToolName[]
  if (missing.length > 0) return missing.filter(name => name !== 'read_temperature' || seen(w, 'read_inventory'))
  if (w.candidates === undefined) return ['build_plans']
  if (w.assessments === undefined) return ['simulate_plans']
  if (w.selection === undefined) return ['draft_recommendation']
  return ['finish']
}
export function executeTool(s: Scenario, w: Workspace, tool: ToolName, selection?: Selection): ToolEvent {
  const missing = prerequisites(s, w, tool)
  let output: unknown, ok = missing.length === 0
  if (!ok) output = { error: 'PREREQUISITE_OR_POLICY', missing }
  else {
    switch (tool) {
      case 'read_demand': output = s.demand; break
      case 'read_inventory': output = s.inventory; break
      case 'read_policy': output = s.policy; break
      case 'read_temperature': output = s.temperature; break
      case 'read_suppliers': output = s.suppliers; break
      case 'read_lanes': output = s.lanes; break
      case 'build_plans':
        w.candidates = usableStock(s) >= s.demand.total ? [plans[0]!] : plans
        output = { packageUnits: 20, usableStock: usableStock(s), candidates: w.candidates }; break
      case 'simulate_plans':
        w.assessments = w.candidates!.map(p => assess(s, p))
        output = { assessments: w.assessments }; break
      case 'draft_recommendation': {
        const chosen = w.assessments!.find(p => p.id === selection)
        // Deterministic safety checks reject unsafe proposals, without choosing a better answer.
        if (selection === undefined || (selection === 'escalate' ? w.assessments!.some(p => p.violations.length === 0) : !chosen || chosen.violations.length > 0)) {
          ok = false; output = { error: 'INVALID_PROPOSAL', selection: selection ?? null }; break
        }
        w.selection = selection
        output = { selection, assessment: chosen ?? null, orderPlaced: false }; break
      }
      case 'finish': output = { readyForWriter: true, orderPlaced: false }; break
      case 'contact_vendor': case 'place_order': throw new Error('Unreachable forbidden tool')
    }
  }
  if (ok && tool !== 'finish') w.observations[tool] = output
  const event = { tool, ok, output }; w.trace.push(event); return event
}
