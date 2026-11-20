export interface A2AScope {
  readonly signal: AbortSignal
  dispose(): void
}

/** Preserve native parent cancellation while owning a deadline only for active work. */
export function createA2AScope(timeoutMs: number, parent?: AbortSignal): A2AScope {
  if (timeoutMs > 0xffff_ffff) throw new RangeError('A2A timeout exceeds the unsigned 32-bit limit')
  const controller = new AbortController()
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal])
  const timer = setTimeout(() => controller.abort(new DOMException(
    'The operation was aborted due to timeout', 'TimeoutError',
  )), timeoutMs)
  ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  const dispose = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  return { signal, dispose }
}
