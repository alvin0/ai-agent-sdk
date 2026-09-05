import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentCodeResolvedCommand } from './types.ts'

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments must be an object')
  }
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

export function optionalString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : requiredString(value, 'value')
}

export function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value as number
}

export function validateResolvedCommand(value: AgentCodeResolvedCommand): AgentCodeResolvedCommand {
  if (typeof value?.executable !== 'string' || value.executable.length === 0) {
    throw new Error('resolved command executable must be a non-empty string')
  }
  if (!Array.isArray(value.args) || value.args.length > 100
    || value.args.some(argument => typeof argument !== 'string')) {
    throw new Error('resolved command args must contain at most 100 strings')
  }
  const env = value.env === undefined ? undefined : validateCommandEnvironment(value.env)
  return Object.freeze({
    executable: value.executable,
    args: Object.freeze([...value.args]),
    ...(env === undefined ? {} : { env }),
  })
}

function validateCommandEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || name.includes('=') || typeof entry !== 'string') {
      throw new Error('resolved command env must contain valid string entries')
    }
    env[name] = entry
  }
  return Object.freeze(env)
}

export async function npmInvocation(args: readonly string[]): Promise<{
  readonly executable: string
  readonly args: readonly string[]
}> {
  if (process.platform !== 'win32') return { executable: 'npm', args }
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { executable: process.execPath, args: [candidate, ...args] }
    } catch {
      // Try the next standard npm CLI location without invoking a command shell.
    }
  }
  throw new Error('could not locate npm-cli.js for shell-free npm execution on Windows')
}

export function shouldTrackDetachedNpmDescendants(args: readonly string[]): boolean {
  const normalized = args.map(argument => argument.toLocaleLowerCase('en-US'))
  const first = normalized[0]
  if (first === 'start') return true
  if (first === 'run' || first === 'run-script') {
    const script = normalized[1] ?? ''
    return /(^|[:_-])(dev|serve|start|preview|e2e|playwright|cypress)([:_-]|$)/.test(script)
  }
  if (first === 'exec' || first === 'x') {
    return normalized.some(argument => /(^|[/@])(playwright|cypress|vite)([/@]|$)/.test(argument))
  }
  return false
}

export function countOccurrences(text: string, needle: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const found = text.indexOf(needle, offset)
    if (found < 0) return count
    count++
    offset = found + needle.length
  }
}
