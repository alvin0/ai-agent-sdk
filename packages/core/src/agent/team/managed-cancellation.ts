

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    // Calling a host callback can synchronously abort and return a rejected
    // promise; retain its rejection observer even though cancellation won.
    void promise.catch(() => undefined)
    throw signal.reason ?? new Error('managed worker aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('managed worker aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return active.length === 1 ? active[0]! : AbortSignal.any(active)
}
