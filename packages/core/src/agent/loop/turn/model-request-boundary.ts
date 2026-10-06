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

// Input the owning session queued while a final answer was being written.
const queuedInput = new WeakMap<History, () => boolean>()
const queuedInputPending = new WeakMap<History, () => boolean>()

/**
 * Let a session hand the loop input it is still holding when a turn would end,
 * and let the loop ask, without taking it, whether a person's input is held.
 */
export function bindQueuedInput(history: History, deliver?: () => boolean, pending?: () => boolean): void {
  if (deliver === undefined) queuedInput.delete(history)
  else queuedInput.set(history, deliver)
  if (pending === undefined) queuedInputPending.delete(history)
  else queuedInputPending.set(history, pending)
}

/** Whether the owning session holds input that would extend this run. */
export function hasQueuedInput(history: History): boolean {
  return queuedInputPending.get(history)?.() ?? false
}

/**
 * Append whatever input the owning session is holding, and say whether any
 * was. Called by the loop only when the turn is free to continue, so the
 * input is answered in this run rather than left behind for the next one.
 */
export function deliverQueuedInput(history: History): boolean {
  return queuedInput.get(history)?.() ?? false
}
