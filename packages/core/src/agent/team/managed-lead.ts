/** Event-driven continuation: idle leads wake only for new settlements. */
import type { TurnHooks } from '../loop/events.ts'

interface ManagedLeadHost {
  flushReports(): Promise<boolean>
  deferReports(): void
  onLeadEnd?(canContinue: boolean): Promise<void> | undefined
  yielded(reason: 'host' | 'workers' | 'capacity'): void
  shouldYield(): boolean
}

/** Bound empty synthesis retries; actual worker progress restores the budget. */
export class ManagedSynthesisGuard {
  private wakes = 0
  constructor(private revision: number, readonly limit = 3) {}
  get used(): number { return this.wakes }
  get exhausted(): boolean { return this.wakes >= this.limit }

  observe(revision: number, outstanding: number): void {
    if (outstanding > 0 || revision !== this.revision) this.wakes = 0
    this.revision = revision
  }

  wake(): void { this.wakes++ }
}

export class ManagedLeadCoordination {
  constructor(private readonly host: ManagedLeadHost) {}

  hooks(host: TurnHooks | undefined): TurnHooks {
    return {
      ...host,
      beforeStep: async context => {
        await this.host.flushReports()
        return await host?.beforeStep?.(context) ?? { kind: 'proceed' as const }
      },
      onTurnEnd: async context => {
        const decision = await host?.onTurnEnd?.(context)
        if (decision?.kind === 'yield') {
          this.host.deferReports(); this.host.yielded('host'); return decision
        }
        // An empty continuation appends nothing, so the lead must still settle its workers.
        if (decision?.kind === 'continue' && context.canContinue
          && (!Array.isArray(decision.messages) || decision.messages.length > 0)) return decision
        return this.finish(context.canContinue)
      },
    }
  }

  private async finish(canContinue: boolean) {
    await this.host.onLeadEnd?.(canContinue)
    // A spent turn may seal appended input with a terminal fallback. Deliver
    // after it goes idle so that fallback cannot consume the synthesis wake.
    if (!canContinue) {
      this.host.deferReports()
      if (!this.host.shouldYield()) return undefined
      this.host.yielded('capacity')
      return { kind: 'yield' as const }
    }
    // With no new information, simply yield. No timer and no polling prompt.
    const delivered = await this.host.flushReports()
    if (!delivered && this.host.shouldYield()) {
      this.host.deferReports()
      this.host.yielded('workers')
      return { kind: 'yield' as const }
    }
    return undefined
  }
}
