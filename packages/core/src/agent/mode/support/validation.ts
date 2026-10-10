import { type AgentMode } from '../run-agent.ts'

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

export function validateAgentModeValue(mode: AgentMode): void {
  if (!['basic', 'deep', 'deep-human-in-loop'].includes(mode)) {
    throw new RangeError('unsupported agent mode "' + String(mode) + '"')
  }
}

export function validateAgentMaxTurns(maxTurns: number | 'auto'): void {
  if (maxTurns !== 'auto' && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new RangeError("maxTurns must be a positive safe integer or 'auto'")
  }
}
