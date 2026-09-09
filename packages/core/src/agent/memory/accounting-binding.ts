import type { RunAccountingPort } from '../accounting/contracts.ts'

const bindings = new WeakMap<object, RunAccountingPort>()

/** Internal session seam: compaction maintenance joins the owning run ledger. */
export function bindCompactionAccounting(owner: object, accounting: RunAccountingPort | undefined): void {
  if (accounting === undefined) bindings.delete(owner)
  else bindings.set(owner, accounting)
}

export function compactionAccounting(owner: object): RunAccountingPort | undefined {
  return bindings.get(owner)
}
