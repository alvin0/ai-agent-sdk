/** Release captured owners after an idempotent disposer has run. */
export function releaseOnce(action: () => void): () => void {
  let pending: (() => void) | undefined = action
  return () => {
    const release = pending
    pending = undefined
    release?.()
  }
}
