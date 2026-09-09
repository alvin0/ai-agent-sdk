import { COMPOSITION_LIMITS } from '../../../capability/common/config.ts'
import { boundedText, objectValue, ownData } from '../../../capability/common/data.ts'
import { DELIVERY_ERROR_CODES } from './config.ts'

export class DeliveryDataError extends Error {
  readonly code = DELIVERY_ERROR_CODES.DATA_INVALID
  constructor() { super('Observation delivery data is invalid'); this.name = 'DeliveryDataError' }
}

export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DeliveryDataError()
  return value
}

export function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DeliveryDataError()
  return value
}

export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DeliveryDataError()
  return value
}

export function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new DeliveryDataError()
  return value as T
}

export function identity(value: unknown): string { return boundedText(value, COMPOSITION_LIMITS.identityBytes) }

export function timestamp(value: unknown): string {
  const text = boundedText(value, 32)
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new DeliveryDataError()
  return text
}

export function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : 'OPERATION_FAILED'
}

export function optional<T>(source: object, key: string, convert: (value: unknown) => T): Record<string, T> {
  const value = ownData(source, key, false)
  return value === undefined ? {} : { [key]: convert(value) }
}

export function numericFields<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, number>> {
  const source = objectValue(value)
  return Object.freeze(Object.fromEntries(keys.map(key => [key, count(ownData(source, key))]))) as Readonly<Record<Key, number>>
}

export function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
