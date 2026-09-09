import { SDK_VERSION, type JsonValue } from '../../primitives/index.ts'
import type { ObservationResource } from '../../observation/index.ts'
import { isSecretKey, redactInlineSecrets } from '../../observation/privacy.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import { arrayData, boundedText, objectValue, ownData } from '../common/data.ts'
import { bytes, DeliveryDataError, optional } from './data.ts'

export interface RuntimeObservationResource extends ObservationResource {
  readonly runtimeId: string
  readonly environment?: string
  readonly attributes?: Readonly<Record<string, JsonValue>>
}

const RESOURCE_LIMITS = Object.freeze({ fields: 64, depth: 8, nodes: 4_096, array: 100, text: 2_048, bytes: 16 * 1024 })
const INPUT_KEYS = new Set(['serviceName', 'serviceVersion', 'environment', 'attributes'])
const PRIVATE_KEYS = new Set(['prompt', 'completion', 'body', 'content', 'messages', 'path', 'filepath', 'cwd', 'directory'])
const CREDENTIAL_KEY = /credential|secret|token/
const prepared = new WeakSet<RuntimeObservationResource>()

export function isRuntimeResource(value: RuntimeObservationResource): boolean { return prepared.has(value) }

/** Constructor metadata, not a general-purpose host-object serializer. */
export function createRuntimeResource(input: unknown, platform: RuntimePlatform): RuntimeObservationResource {
  try {
    let nodes = 0
    const seen = new Set<object>()
    const text = (value: unknown): string => {
      if (typeof value !== 'string' || value.length > RESOURCE_LIMITS.text || redactInlineSecrets(value) !== value) throw new DeliveryDataError()
      return value
    }
    const clone = (value: unknown, depth: number): JsonValue => {
      if (++nodes > RESOURCE_LIMITS.nodes || depth > RESOURCE_LIMITS.depth) throw new DeliveryDataError()
      if (value === null || typeof value === 'boolean') return value
      if (typeof value === 'string') return text(value)
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (Array.isArray(value)) {
        if (seen.has(value)) throw new DeliveryDataError()
        seen.add(value)
        try { return Object.freeze(arrayData(value, RESOURCE_LIMITS.array).map(entry => clone(entry, depth + 1))) as unknown as JsonValue }
        finally { seen.delete(value) }
      }
      const source = objectValue(value)
      if (seen.has(source)) throw new DeliveryDataError()
      seen.add(source)
      try {
        const prototype: unknown = Object.getPrototypeOf(source)
        if (prototype !== Object.prototype && prototype !== null) throw new DeliveryDataError()
        const keys = Object.keys(source)
        if (keys.length > RESOURCE_LIMITS.fields) throw new DeliveryDataError()
        const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
        for (const key of keys) {
          boundedText(key, 128)
          const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
          if (isSecretKey(key) || PRIVATE_KEYS.has(normalized) || CREDENTIAL_KEY.test(normalized)) throw new DeliveryDataError()
          const child = ownData(source, key)
          result[key] = clone(child, depth + 1)
        }
        return Object.freeze(result)
      } finally { seen.delete(source) }
    }
    const source = input === undefined ? {} : objectValue(input)
    const prototype: unknown = Object.getPrototypeOf(source)
    if (prototype !== Object.prototype && prototype !== null) throw new DeliveryDataError()
    if (Object.keys(source).some(key => !INPUT_KEYS.has(key))) throw new DeliveryDataError()
    const metadata = {
      ...optional(source, 'serviceName', value => boundedText(text(value), 128)),
      ...optional(source, 'serviceVersion', value => boundedText(text(value), 128)),
      ...optional(source, 'environment', value => boundedText(text(value), 128)),
      ...optional(source, 'attributes', value => clone(objectValue(value), 0) as Readonly<Record<string, JsonValue>>),
    }
    if (bytes(metadata) > RESOURCE_LIMITS.bytes) throw new DeliveryDataError()
    const resource = Object.freeze({ sdkName: 'ai-agent-sdk' as const, sdkVersion: SDK_VERSION,
      runtime: 'unknown' as const, runtimeId: platform.randomHex(16), ...metadata })
    prepared.add(resource)
    return resource
  } catch { throw new DeliveryDataError() }
}
