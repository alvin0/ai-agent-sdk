import type { JsonObject, JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { ToolCard } from '../wire'

/** Cast a structurally-JSON result to the SDK's `JsonValue`. */
export function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

export function card(value: ToolCard): JsonObject {
  return { card: value } as unknown as JsonObject
}

export function optionalString(raw: unknown, key: string): string | undefined {
  const value = (raw as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function requireString(raw: unknown, key: string): string {
  const value = (raw as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`"${key}" must be a non-empty string`)
  return value
}

export function optionalBoolean(raw: unknown, key: string): boolean {
  return (raw as Record<string, unknown> | null)?.[key] === true
}

export function argString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}
