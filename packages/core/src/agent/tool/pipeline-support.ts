import type { ContentBlock } from '../../message/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { ToolExecutionResult, ToolFailure } from './definition.ts'
import { TOOL_ERROR_CODES, ToolError } from './errors.ts'
import type { ToolInterceptor } from './pipeline.ts'

export function toolFailure(
  message: string,
  code: string,
  extra: { meta?: JsonObject; additionalContext?: readonly ContentBlock[] } = {},
): ToolFailure {
  return {
    isError: true,
    error: { message, code },
    content: [{ type: 'text', text: `Error: ${message}` }],
    ...extra.meta === undefined ? {} : { meta: extra.meta },
    ...extra.additionalContext === undefined ? {} : { additionalContext: extra.additionalContext },
  }
}

export function parseRawArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: {} }
  try { return { ok: true, value: JSON.parse(trimmed) as unknown } }
  catch (error: unknown) { return { ok: false, message: `arguments were not valid JSON: ${messageOf(error)}` } }
}
export function messageOf(value: unknown): string {
  if (value instanceof Error && value.message.length > 0) return value.message
  const rendered = String(value)
  return rendered.length > 0 ? rendered : 'the tool failed without a message'
}
export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}
export function chain<T>(
  interceptors: readonly ToolInterceptor[],
  pick: (interceptor: ToolInterceptor) => ((next: () => Promise<T>) => Promise<T>) | undefined,
  terminal: () => Promise<T>,
): () => Promise<T> {
  let next = terminal
  for (let index = interceptors.length - 1; index >= 0; index--) {
    const interceptor = interceptors[index]
    if (interceptor === undefined) continue
    const hook = pick(interceptor)
    if (hook === undefined) continue
    const inner = next
    next = () => hook(inner)
  }
  return next
}
export async function withTimeout(
  timeoutMs: number | undefined,
  outer: AbortSignal,
  run: (signal: AbortSignal) => Promise<ToolExecutionResult>,
  teardownTimeoutMs: number,
): Promise<ToolExecutionResult> {
  if (timeoutMs === undefined) return await run(outer)
  const expiry = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    expiry.abort(new Error(`tool timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    const signal = AbortSignal.any([outer, expiry.signal])
    const pending = run(signal)
    try {
      const result = await raceWithSignal(pending, signal)
      return expired
        ? toolFailure(`the tool exceeded its ${timeoutMs}ms time limit`, TOOL_ERROR_CODES.TIMEOUT)
        : result
    } catch (error: unknown) {
      const timedOut = expired
      if (!timedOut && !outer.aborted) throw error
      clearTimeout(timer)
      const settled = await waitForSettlement(pending, teardownTimeoutMs)
      if (!settled) {
        throw ToolError.fatal(
          `tool ignored ${timedOut ? 'timeout cancellation' : 'cancellation'} for more than ${teardownTimeoutMs}ms; `
            + 'the in-process operation may still be running',
          TOOL_ERROR_CODES.TEARDOWN_TIMEOUT,
          { cause: error },
        )
      }
      if (!timedOut) return await pending
      return toolFailure(`the tool exceeded its ${timeoutMs}ms time limit`, TOOL_ERROR_CODES.TIMEOUT)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The work has already started even though cancellation won before this call.
    void pending.catch(() => undefined)
    throw signal.reason ?? new Error('tool timed out')
  }
  // Native propagation follows abort algorithms even when an earlier public handler stops event dispatch.
  const watched = AbortSignal.any([signal])
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      watched.removeEventListener('abort', abort)
      reject(watched.reason ?? new Error('tool timed out'))
    }
    watched.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { watched.removeEventListener('abort', abort); resolve(value) },
      error => { watched.removeEventListener('abort', abort); reject(error) },
    )
  })
}
