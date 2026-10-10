import { isAbsolute, relative } from 'node:path'
import { type SkillCandidate } from '@alvin0/ai-agent-sdk-core/skills'
import type { FileSystemSkillsOptions, FileSystemSkillIoEvent, FileLocator } from './filesystem-types.ts'

export function normalize(value: string): string { return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') }

export function unquote(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(value)
  return match?.[2] ?? value
}

export function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right
}

export function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path.length === 0 || (!path.startsWith('..') && !isAbsolute(path))
}

export function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('skill discovery aborted')
}

export function emitIo(
  listener: FileSystemSkillsOptions['onIo'],
  event: FileSystemSkillIoEvent,
): void {
  try { listener?.(Object.freeze(event)) }
  catch { /* Diagnostics must not change skill-loading behavior. */ }
}

export function asLocator(value: unknown, skillId: string): FileLocator {
  if (typeof value !== 'object' || value === null
    || typeof (value as FileLocator).skillFile !== 'string'
    || typeof (value as FileLocator).directory !== 'string') {
    throw new TypeError(`filesystem skill '${skillId}' has an invalid locator`)
  }
  return value as FileLocator
}

export function assertIssuedCandidate(
  issued: WeakSet<object>, candidate: SkillCandidate, providerId: string,
): void {
  if (!issued.has(candidate)) {
    throw new TypeError(`skill provider '${providerId}' received a candidate it did not issue`)
  }
}

export function booleanField(fields: ReadonlyMap<string, string>, key: string, fallback: boolean): boolean {
  const value = fields.get(key)
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TypeError(`skill front matter '${key}' must be true or false`)
}

export function boundedInteger(
  value: number | undefined, fallback: number, bounds: { min: number; max: number; name: string },
): number {
  const { min, max, name } = bounds
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return resolved
}