import type { CopilotAccountIdentity } from './common/store-types.ts'
import { deviceFailure } from './oauth-errors.ts'

/** Identity fields, present only when the endpoint disclosed them (Property 16). */
export function accountIdentityOf(body: Record<string, unknown>): CopilotAccountIdentity | undefined {
  const login = optionalString(body.login)
  const name = optionalString(body.name)
  const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : undefined
  if (login === undefined && name === undefined && id === undefined) return undefined
  return Object.freeze({
    ...login === undefined ? {} : { login },
    ...name === undefined ? {} : { name },
    ...id === undefined ? {} : { id },
  })
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function requireDeviceString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw deviceFailure(`the device flow response omitted "${key}"`, 'failed')
  }
  return value
}

/**
 * Read a seconds value that the endpoint may send as a number, as a numeric
 * string, or not at all.
 *
 * GitHub has been observed sending `interval` as a string, so both forms are
 * accepted; anything unparsable falls back rather than failing the login, because
 * a bad hint about pacing is not a reason to refuse a working authorization.
 */
export function positiveSecondsOf(value: unknown, fallbackSeconds: number): number {
  const parsed = secondsNumber(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds
}

function secondsNumber(value: unknown): number {
  if (typeof value === 'number') return value
  return typeof value === 'string' ? Number.parseInt(value.trim(), 10) : Number.NaN
}
