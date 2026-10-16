/** Compact per-item accountability, independent of result delivery and text truncation. */
export interface BatchCoverage {
  completed: number
  failed: string[]
  pending: string[]
  deficit: string[]
}

type ItemStatus = 'assigned' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export class ManagedBatchCoverage {
  private readonly items = new Map<string, {
    id: string; status: ItemStatus; usable: boolean; settled: Promise<void>; resolve(): void
  }>()

  assign(targets: readonly string[], ids: readonly (string | undefined)[]): void {
    targets.forEach((target, index) => {
      let resolve!: () => void
      const settled = new Promise<void>(done => { resolve = done })
      this.items.set(target, { id: ids[index] ?? target, status: 'assigned', usable: false, settled, resolve })
    })
  }

  update(target: string, status: ItemStatus, usable = false): void {
    const item = this.items.get(target)!
    if (['completed', 'failed', 'cancelled'].includes(item.status)) return
    item.status = status
    item.usable = usable
    if (['completed', 'failed', 'cancelled'].includes(status)) item.resolve()
  }

  wait(target: string): Promise<void> { return this.items.get(target)!.settled }
  async settled(): Promise<void> { await Promise.all([...this.items.values()].map(item => item.settled)) }

  view(): BatchCoverage {
    const items = [...this.items.values()]
    const terminal = (status: ItemStatus) => ['completed', 'failed', 'cancelled'].includes(status)
    return {
      completed: items.filter(item => item.status === 'completed' && item.usable).length,
      failed: items.filter(item => item.status === 'failed').map(item => item.id),
      pending: items.filter(item => !terminal(item.status)).map(item => item.id),
      deficit: items.filter(item => terminal(item.status) && !item.usable).map(item => item.id),
    }
  }
}
