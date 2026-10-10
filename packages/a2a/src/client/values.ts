
export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`)
  if (value.length > 256) throw new TypeError(`${label} must be at most 256 characters`)
  return value
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function byteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('A2A value is not JSON serializable')
  return utf8Bytes(serialized)
}

export function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 1) return active[0]!
  return AbortSignal.any(active)
}

export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  if (signal.aborted) throw signal.reason ?? new Error('A2A operation aborted')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('A2A operation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
