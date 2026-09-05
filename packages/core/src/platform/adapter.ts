import { PLATFORM_LIMITS, timeoutValue, type UniversalFeature } from './config.ts'

export class UnsupportedRuntimeError extends Error {
  readonly code = 'UNSUPPORTED_RUNTIME' as const
  constructor(readonly feature: UniversalFeature) {
    super(`Required Web Platform feature is unavailable: ${feature}`)
    this.name = 'UnsupportedRuntimeError'
  }
}

export interface RuntimePlatform {
  monotonicNow(): number
  wallNow(): number
  randomHex(bytes: number): string
  controller(): AbortController
  after(milliseconds: number, callback: () => void): () => void
}

function feature<T>(name: UniversalFeature, read: () => T): T {
  try {
    const value = read()
    if (typeof value !== 'function') throw new Error('not callable')
    return value
  } catch { throw new UnsupportedRuntimeError(name) }
}

function randomHex(bytes: number, fill: (data: Uint8Array) => Uint8Array): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PLATFORM_LIMITS.maxRandomBytes) {
    throw new RangeError('Random identifier size exceeds its bound')
  }
  for (let attempt = 0; attempt < PLATFORM_LIMITS.randomAttempts; attempt++) {
    const values = new Uint8Array(bytes)
    try { fill(values) } catch { throw new UnsupportedRuntimeError('crypto.getRandomValues') }
    if (values.some(value => value !== 0)) {
      return [...values].map(value => value.toString(16).padStart(2, '0')).join('')
    }
  }
  throw new UnsupportedRuntimeError('crypto.getRandomValues')
}

/** Advanced standalone entrypoints share ID generation without allocating a runtime. */
export function systemRandomHex(bytes: number): string {
  let receiver: Crypto
  const fill = feature('crypto.getRandomValues', () => {
    receiver = globalThis.crypto
    return receiver.getRandomValues
  })
  return randomHex(bytes, data => Reflect.apply(fill, receiver!, [data]) as Uint8Array)
}

export function systemRandomId(): string {
  const hex = systemRandomHex(16)
  const variant = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`
}

function monotonicNow(receiver: Performance, now: Performance['now']): number {
  let value: number
  try { value = Reflect.apply(now, receiver, []) as number }
  catch { throw new UnsupportedRuntimeError('performance.now') }
  if (!Number.isFinite(value) || value < 0) throw new UnsupportedRuntimeError('performance.now')
  return value
}

export function systemMonotonicNow(): number {
  let receiver: Performance
  const now = feature('performance.now', () => {
    receiver = globalThis.performance
    return receiver.now
  })
  return monotonicNow(receiver!, now)
}

/** Validate and capture the Universal baseline without constructing resources or reading plugins. */
export function createRuntimePlatform(host: typeof globalThis = globalThis): RuntimePlatform {
  const Controller = feature('AbortController', () => host.AbortController)
  feature('AbortSignal.any', () => host.AbortSignal.any)
  feature('AbortSignal.timeout', () => host.AbortSignal.timeout)
  feature('DOMException', () => host.DOMException)
  feature('ReadableStream', () => host.ReadableStream)
  feature('TextDecoder', () => host.TextDecoder)
  feature('TextEncoder', () => host.TextEncoder)
  feature('URL', () => host.URL)
  let randomReceiver: Crypto
  const fill = feature('crypto.getRandomValues', () => {
    randomReceiver = host.crypto
    return randomReceiver.getRandomValues
  })
  let clockReceiver: Performance
  const now = feature('performance.now', () => {
    clockReceiver = host.performance
    return clockReceiver.now
  })
  feature('structuredClone', () => host.structuredClone)
  const schedule = feature('timers', () => host.setTimeout)
  const cancel = feature('timers', () => host.clearTimeout)
  const wall = Date.now
  return Object.freeze({
    monotonicNow(): number {
      return monotonicNow(clockReceiver!, now)
    },
    wallNow: () => wall(),
    randomHex: (bytes: number) => randomHex(bytes, data => Reflect.apply(fill, randomReceiver!, [data]) as Uint8Array),
    controller: () => new Controller(),
    after(milliseconds: number, callback: () => void): () => void {
      timeoutValue(milliseconds, true)
      let active = true
      const handle = Reflect.apply(schedule, host, [() => {
        if (!active) return
        active = false
        callback()
      }, milliseconds]) as ReturnType<typeof setTimeout>
      return () => {
        if (!active) return
        active = false
        Reflect.apply(cancel, host, [handle])
      }
    },
  })
}
