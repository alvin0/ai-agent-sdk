import type { History } from '../../history/history.ts'

// Session bookkeeping is separate from user hooks and their operation ledger.
const observers = new WeakMap<History, (inFlight: boolean) => void>()

export function bindModelRequestBoundary(history: History, observer?: (inFlight: boolean) => void): void {
  if (observer === undefined) observers.delete(history)
  else observers.set(history, observer)
}

export function observeModelRequestBoundary(history: History, inFlight: boolean): void {
  observers.get(history)?.(inFlight)
}
