/** Exact attempt coverage: a matching row count is not proof of a complete cohort. */
export interface AttemptManifest {
  readonly phase?: string
  readonly repeats: number
  readonly selected: readonly { readonly id: string; readonly split: string; readonly unsupported: string | null }[]
}
export interface AttemptRecord {
  readonly id: string
  readonly split: string
  readonly repeat: number
  readonly status: string
  readonly arm?: string
}

export function validateAttempts(config: AttemptManifest, rows: readonly AttemptRecord[], paired = false): void {
  if (!Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 10
    || !Array.isArray(config.selected) || config.selected.length === 0) throw new Error('Invalid attempt manifest')
  const expected = new Map<string, { readonly split: string; readonly unsupported: boolean }>()
  const families = new Set<string>()
  const key = (id: string, repeat: number, arm?: string) => JSON.stringify([id, repeat, arm ?? null])
  for (const test of config.selected) {
    if (typeof test.id !== 'string' || test.id.length === 0 || families.has(test.id)
      || !['development', 'calibration', 'held-out'].includes(test.split)
      || (test.unsupported !== null && typeof test.unsupported !== 'string')) throw new Error('Invalid selected family')
    families.add(test.id)
    const count = test.unsupported ? 1 : paired || config.phase === 'pilot' || test.split === 'held-out' ? config.repeats : 1
    for (let repeat = 0; repeat < count; repeat++) {
      for (const arm of paired ? ['BASE', 'PTC'] : [undefined]) {
        expected.set(key(test.id, repeat, arm), { split: test.split, unsupported: !!test.unsupported })
      }
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const identity = key(row.id, row.repeat, row.arm)
    if (seen.has(identity)) throw new Error('Duplicate run records')
    seen.add(identity)
    const task = expected.get(identity)
    if (task === undefined || row.split !== task.split || !Number.isSafeInteger(row.repeat)
      || !['passed', 'failed', 'needs-review', 'unsupported', 'runtime-failed', 'runtime-error'].includes(row.status)
      || (row.status === 'unsupported') !== task.unsupported) throw new Error(`Unexpected attempt: ${row.id}:${String(row.repeat)}`)
  }
  if (seen.size !== expected.size) throw new Error(`Incomplete run: ${String(seen.size)}/${String(expected.size)}`)
}

export function requireIntegrityEntries(integrity: Record<string, string>, files: readonly string[]): void {
  for (const file of files) {
    if (!Object.hasOwn(integrity, file) || !/^[a-f0-9]{64}$/.test(integrity[file]!)) {
      throw new Error(`Missing integrity entry: ${file}`)
    }
  }
}
