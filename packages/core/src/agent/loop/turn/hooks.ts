import { waitForSettlement } from '../../../async/index.ts'
import { type RunTurnOptions } from './types.ts'
import { positiveSafeInteger } from './config.ts'
import { codedRuntimeError } from './common.ts'
import { nextValueWithAbort } from './cancellation.ts'

export async function runOptionalHook<TArgs extends readonly unknown[], TResult>(
  hook: ((...args: TArgs) => TResult | Promise<TResult>) | undefined,
  args: TArgs,
  options: RunTurnOptions,
  context: { signal: AbortSignal; name: string },
): Promise<Awaited<TResult> | undefined> {
  const { signal, name } = context
  if (hook === undefined) return undefined
  const owned = new AbortController()
  const hookSignal = AbortSignal.any([signal, owned.signal])
  const scoped = args.map(arg => typeof arg === 'object' && arg !== null && 'signal' in arg
    ? { ...arg, signal: hookSignal } : arg) as unknown as TArgs
  const pending = Promise.resolve().then(() => hook(...scoped))
  return await runHook(pending, options, signal, { name, onCancellation: reason => owned.abort(reason) })
}
export async function runHook<T>(
  pending: Promise<T>,
  options: RunTurnOptions,
  signal: AbortSignal,
  context: { name: string; onCancellation?: (reason: unknown) => void },
): Promise<T> {
  const { name, onCancellation } = context
  const operation = options.accounting?.startOperation('hook', { data: { name } })
  const timeoutMs = positiveSafeInteger(options.hookTimeoutMs ?? 10 * 60_000, 'hookTimeoutMs')
  const teardownTimeoutMs = positiveSafeInteger(
    options.hookTeardownTimeoutMs ?? 30_000,
    'hookTeardownTimeoutMs',
  )
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  try {
    const value = await nextValueWithAbort(pending, combined)
    endHookOperation(options, operation, 'success')
    return value
  } catch (error: unknown) {
    if (!combined.aborted) {
      endHookOperation(options, operation, 'error', { error })
      throw error
    }
    onCancellation?.(combined.reason)
    const settled = await waitForSettlement(pending, teardownTimeoutMs)
    if (!settled) {
      const runtimeError = codedRuntimeError(
        `turn hook '${name}' ignored cancellation for more than ${teardownTimeoutMs}ms`,
        'HOOK_TEARDOWN_TIMEOUT',
        error,
      )
      endHookOperation(options, operation, 'error', { error: runtimeError })
      throw runtimeError
    }
    if (deadline.aborted && !signal.aborted) {
      const runtimeError = codedRuntimeError(`turn hook '${name}' exceeded ${timeoutMs}ms`, 'HOOK_TIMEOUT', error)
      endHookOperation(options, operation, 'error', { error: runtimeError })
      throw runtimeError
    }
    endHookOperation(options, operation, 'aborted', { error })
    throw error
  }
}

function endHookOperation(options: RunTurnOptions, operation: string | undefined,
  status: 'success' | 'error' | 'aborted', input?: { error: unknown }): void {
  if (operation === undefined) return
  if (input === undefined) options.accounting?.endOperation(operation, status)
  else options.accounting?.endOperation(operation, status, input)
}
