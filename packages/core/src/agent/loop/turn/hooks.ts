import { waitForSettlement } from '../../../async/index.ts'
import { type RunTurnOptions } from './types.ts'
import { positiveSafeInteger } from './config.ts'
import { codedRuntimeError } from './common.ts'
import { nextValueWithAbort } from './cancellation.ts'

export async function runOptionalHook<TArgs extends readonly unknown[], TResult>(
  hook: ((...args: TArgs) => TResult | Promise<TResult>) | undefined,
  args: TArgs,
  options: RunTurnOptions,
  signal: AbortSignal,
  name: string,
): Promise<Awaited<TResult> | undefined> {
  if (hook === undefined) return undefined
  const pending = Promise.resolve().then(() => hook(...args))
  return await runHook(pending, options, signal, name)
}
export async function runHook<T>(
  pending: Promise<T>,
  options: RunTurnOptions,
  signal: AbortSignal,
  name: string,
): Promise<T> {
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
    if (operation !== undefined) options.accounting?.endOperation(operation, 'success')
    return value
  } catch (error: unknown) {
    if (!combined.aborted) {
      if (operation !== undefined) options.accounting?.endOperation(operation, 'error', { error })
      throw error
    }
    const settled = await waitForSettlement(pending, teardownTimeoutMs)
    if (!settled) {
      const runtimeError = codedRuntimeError(
        `turn hook '${name}' ignored cancellation for more than ${teardownTimeoutMs}ms`,
        'HOOK_TEARDOWN_TIMEOUT',
        error,
      )
      if (operation !== undefined) options.accounting?.endOperation(operation, 'error', { error: runtimeError })
      throw runtimeError
    }
    if (deadline.aborted && !signal.aborted) {
      const runtimeError = codedRuntimeError(`turn hook '${name}' exceeded ${timeoutMs}ms`, 'HOOK_TIMEOUT', error)
      if (operation !== undefined) options.accounting?.endOperation(operation, 'error', { error: runtimeError })
      throw runtimeError
    }
    if (operation !== undefined) options.accounting?.endOperation(operation, 'aborted', { error })
    throw error
  }
}
