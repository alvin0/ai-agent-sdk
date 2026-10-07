import { bindStepProjectionSources } from '../loop/turn/step-projection.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import type { TurnHooks } from '../loop/types.ts'
import { bindCompactionAccounting } from '../memory/accounting-binding.ts'
import { renderRuntimeMemory } from './session/runtime-memory.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { AgentSessionActivatedSkillSnapshot } from './session/types.ts'
import type { SkillLookupOptions } from '../skill/index.ts'

export function combinedSessionHooks(host: any, accounting?: RunAccountingPort): TurnHooks | undefined {
    const user = host.options.hooks
    const hooks: TurnHooks = {
      ...user,
      beforeStep: async context => beforeSessionStep(host, accounting, user, context),
      onRequestError: async context => {
        if (host.compactor !== undefined) bindCompactionAccounting(host.compactor, accounting)
        const recovery = await host.compactor?.onRequestError(context)
        if (accounting?.usageStop !== undefined) return 'fail'
        if (recovery === 'retry') return 'retry'
        return await user?.onRequestError?.(context) ?? 'fail'
      },
    }
    return hooks
  }

export function sessionSkillLookup(host: any, signal?: AbortSignal): SkillLookupOptions {
    return {
      ...(host.options.skillCwd === undefined ? {} : { cwd: host.options.skillCwd }),
      ...(signal === undefined ? {} : { signal }),
    }
  }
export function sessionActivationSnapshot(host: any, ): readonly AgentSessionActivatedSkillSnapshot[] {
    const activated = new Map<string, AgentSessionActivatedSkillSnapshot>()
    for (const entry of host.pendingSkillActivations) activated.set(entry.id, entry)
    for (const reference of host.skillCatalog?.activatedSkillReferences() ?? []) {
      activated.set(reference.id, reference)
    }
    for (const summary of host.skillCatalog?.activatedSummaries() ?? []) {
      if (activated.has(summary.id)) continue
      activated.set(summary.id, Object.freeze({
        id: summary.id, provider: summary.provider, source: summary.source,
        ...summary.resourceBase === undefined ? {} : {
          resourceBase: Object.freeze({ ...summary.resourceBase }),
        },
      }))
    }
    return Object.freeze([...activated.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

function unchangedHistory(host: any, generation: number, entries: number): boolean {
  return host.currentHistory.generation() === generation
    && host.currentHistory.entries().length === entries
}

function projectedContext(host: any, context: any): any {
  return { ...context, messages: normalizeToolPairing(host.currentHistory.messages()),
    snapshot: host.currentHistory.snapshot() }
}

function addMemory(context: any, memory: readonly any[]): any {
  return memory.length === 0 ? context : { ...context, messages: Object.freeze([...memory, ...context.messages]) }
}

function compactionStopped(accounting: RunAccountingPort | undefined): boolean {
  return accounting?.usageStop !== undefined
}

function prependDecision(decision: any, memory: readonly any[], messages: readonly any[]): any {
  const prepend = [...(decision.messages === undefined ? memory : []), ...decision.prepend ?? []]
  return bindStepProjectionSources(prepend.length === 0 ? decision : { ...decision, prepend }, messages)
}

async function beforeSessionStep(
  host: any, accounting: RunAccountingPort | undefined, user: any, context: any,
): Promise<any> {
  const generation = host.currentHistory.generation()
  const entries = host.currentHistory.entries().length
  host.drainInjections()
  const prepared = unchangedHistory(host, generation, entries) ? context : projectedContext(host, context)
  if (host.compactor !== undefined) bindCompactionAccounting(host.compactor, accounting)
  await host.compactor?.beforeStep(prepared)
  if (compactionStopped(accounting)) return { kind: 'proceed' as const }
  const refreshed = unchangedHistory(host, generation, entries) ? context : projectedContext(host, context)
  const memory = renderRuntimeMemory(host.currentMemory, host.definition.memory.maxInjectedChars, accounting)
  const current = addMemory(refreshed, memory)
  const decision = await user?.beforeStep?.(current) ?? { kind: 'proceed' as const }
  if (decision.kind === 'reject') return decision
  return prependDecision(decision, memory, refreshed.messages)
}
