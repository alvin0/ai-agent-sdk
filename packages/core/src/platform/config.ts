/** Internal Web Platform bounds. Runtime-owned deadlines never overflow host timers. */
export const PLATFORM_LIMITS = Object.freeze({
  maxTimeoutMs: 2_147_483_647,
  randomAttempts: 8,
  maxRandomBytes: 32,
})

export const UNIVERSAL_FEATURES = Object.freeze([
  'AbortController', 'AbortSignal.any', 'AbortSignal.timeout', 'DOMException',
  'ReadableStream', 'TextDecoder', 'TextEncoder', 'URL', 'crypto.getRandomValues',
  'performance.now', 'structuredClone', 'timers',
] as const)

export type UniversalFeature = typeof UNIVERSAL_FEATURES[number]

export function timeoutValue(value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > PLATFORM_LIMITS.maxTimeoutMs) {
    throw new RangeError('Timeout must be a bounded integer number of milliseconds')
  }
  return value
}
