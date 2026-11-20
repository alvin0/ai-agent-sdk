
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

export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  const cancellation = AbortSignal.any([signal])
  if (signal.aborted) {
    void pending.catch(() => undefined)
    throw signal.reason ?? new Error('A2A operation aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      cancellation.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('A2A operation aborted'))
    }
    cancellation.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cancellation.removeEventListener('abort', abort); resolve(value) },
      error => { cancellation.removeEventListener('abort', abort); reject(error) },
    )
  })
}
