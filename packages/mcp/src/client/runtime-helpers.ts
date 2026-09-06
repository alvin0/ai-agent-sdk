import type { ToolFilter } from '@ai-agent-sdk/core/tools'
import { isJsonValue, type JsonValue } from '@ai-agent-sdk/core'
import type {
  McpAuthenticationKind,
  McpReconnectOptions,
  ResolvedMcpReconnectOptions,
} from './api-types.ts'
import { MCP_RECONNECT_DEFAULTS } from './config.ts'

export function resolveMcpReconnectOptions(
  input: McpReconnectOptions | false | undefined,
): ResolvedMcpReconnectOptions {
  if (input === false) return Object.freeze({ ...MCP_RECONNECT_DEFAULTS, enabled: false })
  const resolved = {
    enabled: input?.enabled ?? MCP_RECONNECT_DEFAULTS.enabled,
    initialDelayMs: input?.initialDelayMs ?? MCP_RECONNECT_DEFAULTS.initialDelayMs,
    maxDelayMs: input?.maxDelayMs ?? MCP_RECONNECT_DEFAULTS.maxDelayMs,
    maxAttempts: input?.maxAttempts ?? MCP_RECONNECT_DEFAULTS.maxAttempts,
  }
  assertPositive(resolved.initialDelayMs, 'reconnect.initialDelayMs')
  assertPositive(resolved.maxDelayMs, 'reconnect.maxDelayMs')
  if (resolved.initialDelayMs > resolved.maxDelayMs) {
    throw new TypeError('reconnect.initialDelayMs must be less than or equal to reconnect.maxDelayMs')
  }
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new TypeError('reconnect.maxAttempts must be a positive integer')
  }
  return Object.freeze(resolved)
}

export function authenticationKindOf(
  provider: unknown,
  headers: Headers,
): McpAuthenticationKind {
  if (provider === undefined) return headers.has('authorization') ? 'bearer' : 'none'
  return isOAuthClientProvider(provider) ? 'oauth' : 'bearer'
}

function isOAuthClientProvider(provider: unknown): boolean {
  if (typeof provider !== 'object' || provider === null) return false
  const candidate = provider as Record<string, unknown>
  return typeof candidate.clientInformation === 'function'
    && typeof candidate.tokens === 'function'
    && typeof candidate.saveTokens === 'function'
    && typeof candidate.redirectToAuthorization === 'function'
    && typeof candidate.saveCodeVerifier === 'function'
    && typeof candidate.codeVerifier === 'function'
}

export function filterRemoteTools<T extends { readonly name: string }>(
  tools: readonly T[],
  filter: ToolFilter | undefined,
): readonly T[] {
  const allow = filter?.allow === undefined ? undefined : new Set(filter.allow)
  const deny = new Set(filter?.deny ?? [])
  return tools.filter(tool => (allow === undefined || allow.has(tool.name)) && !deny.has(tool.name))
}

export function publicToolName(serverName: string, remoteName: string, prefixed: boolean): string {
  return prefixed ? `mcp__${serverName}__${remoteName}` : remoteName
}

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertServerName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new TypeError('MCP serverName must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/')
  }
}

export function assertPositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`)
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('MCP value is not JSON serializable')
  return new TextEncoder().encode(serialized).byteLength
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export class McpOperationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpOperationTimeoutError'
  }
}

export function createAbortTimeoutScope(
  timeoutMs: number,
  message: string,
  callerSignal?: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const timeout = new McpOperationTimeoutError(message)
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
  const signal = callerSignal === undefined
    ? controller.signal
    : AbortSignal.any([callerSignal, controller.signal])
  let active = true
  const dispose = (): void => {
    if (!active) return
    active = false
    clearTimeout(timer)
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  return Object.freeze({ signal, dispose })
}

export function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  callerSignal?: AbortSignal,
): Promise<T> {
  const scope = createAbortTimeoutScope(timeoutMs, message, callerSignal)
  let pending: Promise<T>
  try {
    scope.signal.throwIfAborted()
    pending = Promise.resolve(operation(scope.signal))
  }
  catch (error: unknown) { scope.dispose(); return Promise.reject(error) }
  return raceAbort(pending, scope.signal).finally(scope.dispose)
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error('MCP operation aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('MCP operation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
