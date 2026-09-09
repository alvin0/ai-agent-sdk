import type { HumanArtifactInvariant } from '../../artifacts.ts'

export class StressChecks {
  private readonly invariants: HumanArtifactInvariant[] = []

  check(name: string, passed: boolean, detail?: string): void {
    this.invariants.push(Object.freeze({
      name,
      passed,
      ...(detail === undefined || passed ? {} : { detail }),
    }))
  }

  equal(name: string, actual: unknown, expected: unknown): void {
    this.check(name, Object.is(actual, expected), `expected=${brief(expected)} actual=${brief(actual)}`)
  }

  items(): readonly HumanArtifactInvariant[] { return Object.freeze([...this.invariants]) }
}

export async function runBoundedWorkers(
  total: number,
  parallel: number,
  signal: AbortSignal,
  work: (index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(total, parallel) }, async () => {
    while (true) {
      signal.throwIfAborted()
      const index = cursor++
      if (index >= total) return
      await work(index)
    }
  })
  await Promise.all(workers)
}

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= 240 ? text : `${text.slice(0, 208)}… <${text.length} chars>`
}

