import type { compactionAccounting } from './accounting-binding.ts'

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('compaction model payload is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

export function assertUsageAdmission(accounting: ReturnType<typeof compactionAccounting>): void {
  const stop = accounting?.usageStop
  if (stop !== undefined) throw codedError(
    'compaction cannot dispatch after a mandatory usage stop',
    stop.usageRequired ? 'USAGE_REQUIRED' : 'USAGE_UNAVAILABLE',
  )
}

export function codedError(message: string, code: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string }
  error.code = code
  return error
}

export function modelTimeoutError(timeoutMs: number, cause: unknown): Error & { code: string } {
  return codedError(`compaction model operation exceeded ${timeoutMs}ms`, 'MODEL_TIMEOUT', cause)
}

export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    throw signal.reason ?? new Error('operation aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

