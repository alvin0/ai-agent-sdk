/** Add monotonic health/accounting counters without wrapping past safe integer precision. */
export function saturatingCounterAdd(left: number, right: number): number {
  const total = left + right
  return Number.isSafeInteger(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER
}
