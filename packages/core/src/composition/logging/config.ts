import type { LogLevel } from '../../logging/types.ts'

export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
})
export const RUNTIME_LOG_LIMITS = Object.freeze({ scopeBytes: 64, messageCharacters: 2_048, identityBytes: 128 })
