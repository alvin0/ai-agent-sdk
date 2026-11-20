import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { MCP_SERVER_DEFAULTS } from '../common/config.ts'
import type { SdkMcpServerOptions, McpServerErrorContext } from './advanced-types.ts'

export interface ResolvedMcpServerLimits {
  readonly maxExports: number
  readonly maxDefinitionBytes: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly operationTimeoutMs: number
  readonly teardownTimeoutMs: number
  readonly observerTimeoutMs: number
}


export function assertIdentity(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be empty`)
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message.length > 0 ? value.message : String(value)
}

export function resolveLimits(options: SdkMcpServerOptions): ResolvedMcpServerLimits {
  return {
    maxExports: positiveSafeInteger(options.maxExports ?? MCP_SERVER_DEFAULTS.maxExports, 'maxExports'),
    maxDefinitionBytes: positiveSafeInteger(
      options.maxDefinitionBytes ?? MCP_SERVER_DEFAULTS.maxDefinitionBytes, 'maxDefinitionBytes',
    ),
    maxInputBytes: positiveSafeInteger(options.maxInputBytes ?? MCP_SERVER_DEFAULTS.maxInputBytes, 'maxInputBytes'),
    maxOutputBytes: positiveSafeInteger(options.maxOutputBytes ?? MCP_SERVER_DEFAULTS.maxOutputBytes, 'maxOutputBytes'),
    operationTimeoutMs: positiveSafeInteger(
      options.operationTimeoutMs ?? MCP_SERVER_DEFAULTS.operationTimeoutMs, 'operationTimeoutMs',
    ),
    teardownTimeoutMs: positiveSafeInteger(
      options.teardownTimeoutMs ?? MCP_SERVER_DEFAULTS.teardownTimeoutMs, 'teardownTimeoutMs',
    ),
    observerTimeoutMs: positiveSafeInteger(
      options.observerTimeoutMs ?? MCP_SERVER_DEFAULTS.observerTimeoutMs, 'observerTimeoutMs',
    ),
  }
}

export async function reportError(
  options: SdkMcpServerOptions,
  limits: ResolvedMcpServerLimits,
  error: unknown,
  evidence: McpServerErrorContext,
): Promise<void> {
  if (options.onError === undefined) return
  const pending = Promise.resolve().then(() => options.onError?.(error, Object.freeze({
    ...evidence,
  })))
  await waitForSettlement(pending, limits.observerTimeoutMs)
}

export function internalErrorMessage(options: SdkMcpServerOptions, error: unknown, fallback: string): string {
  return options.exposeInternalErrors === true ? errorMessage(error) : fallback
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`MCP server ${label} must be a positive safe integer`)
  }
  return value
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('MCP server value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

/** Own the operation timer and upstream listener until its invocation settles. */
export function createOperationScope(
  parent: AbortSignal, timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } {
  if (timeoutMs > 0xffff_ffff) throw new RangeError('MCP server operation timeout exceeds the unsigned 32-bit limit')
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
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

export async function raceWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  teardownTimeoutMs: number,
): Promise<T> {
  const cancellation = AbortSignal.any([signal])
  try {
    if (cancellation.aborted) throw cancellation.reason ?? new Error('MCP server operation aborted')
    return await new Promise<T>((resolve, reject) => {
      const abort = () => {
        cancellation.removeEventListener('abort', abort)
        reject(cancellation.reason ?? new Error('MCP server operation aborted'))
      }
      cancellation.addEventListener('abort', abort, { once: true })
      void pending.then(
        value => { cancellation.removeEventListener('abort', abort); resolve(value) },
        error => { cancellation.removeEventListener('abort', abort); reject(error) },
      )
    })
  } catch (error: unknown) {
    if (signal.aborted) await waitForSettlement(pending, teardownTimeoutMs)
    throw error
  }
}
