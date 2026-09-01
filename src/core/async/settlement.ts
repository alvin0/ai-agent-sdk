/** Bounded waiting for cooperative teardown paths. */

export async function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('settlement timeoutMs must be a positive finite number')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = promise.then(() => true, () => true)
  const expired = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([settled, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
