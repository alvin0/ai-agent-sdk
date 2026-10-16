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
  constructor(private revision: number) {}

  observe(revision: number, outstanding: number): void {
    if (outstanding > 0 || revision !== this.revision) this.wakes = 0
    this.revision = revision
  }

  wake(): void {
    if (this.wakes >= 3) {
      throw new Error('Lead synthesis stalled: yielded after 3 synthesis wakes without new worker reports')
    }
    this.wakes++
  }
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
        await this.host.onLeadEnd?.(context.canContinue)
        // A spent turn may seal appended input with a terminal fallback. Deliver
        // after it goes idle so that fallback cannot consume the synthesis wake.
        if (!context.canContinue) {
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
      },
    }
  }
}
