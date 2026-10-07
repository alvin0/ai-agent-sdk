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
const PRIVATE_KEYS = new Set(['prompt', 'completion', 'body', 'content', 'messages', 'path', 'filepath', 'cwd',
  'directory'])
const CREDENTIAL_KEY = /credential|secret|token/
const prepared = new WeakSet<RuntimeObservationResource>()

export function isRuntimeResource(value: RuntimeObservationResource): boolean { return prepared.has(value) }

interface CloneState { nodes: number; seen: Set<object> }

function cloneText(value: unknown): string {
  if (typeof value !== 'string' || value.length > RESOURCE_LIMITS.text
    || redactInlineSecrets(value) !== value) throw new DeliveryDataError()
  return value
}

function cloneResourceValue(value: unknown, depth: number, state: CloneState): JsonValue {
  if (++state.nodes > RESOURCE_LIMITS.nodes || depth > RESOURCE_LIMITS.depth) throw new DeliveryDataError()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return cloneText(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return cloneResourceArray(value, depth, state)
  return cloneResourceObject(objectValue(value), depth, state)
}

function cloneResourceArray(value: readonly unknown[], depth: number, state: CloneState): JsonValue {
  if (state.seen.has(value)) throw new DeliveryDataError()
  state.seen.add(value)
  try {
    return Object.freeze(arrayData(value, RESOURCE_LIMITS.array).map(entry =>
      cloneResourceValue(entry, depth + 1, state))) as unknown as JsonValue
  } finally { state.seen.delete(value) }
}

function cloneResourceObject(source: object, depth: number, state: CloneState): JsonValue {
  if (state.seen.has(source)) throw new DeliveryDataError()
  state.seen.add(source)
  try {
    if (!isPlainObject(source)) throw new DeliveryDataError()
    const keys = Object.keys(source)
    if (keys.length > RESOURCE_LIMITS.fields) throw new DeliveryDataError()
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const key of keys) {
      boundedText(key, 128)
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (isSecretKey(key) || PRIVATE_KEYS.has(normalized) || CREDENTIAL_KEY.test(normalized)) {
        throw new DeliveryDataError()
      }
      result[key] = cloneResourceValue(ownData(source, key), depth + 1, state)
    }
    return Object.freeze(result)
  } finally { state.seen.delete(source) }
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Constructor metadata, not a general-purpose host-object serializer. */
export function createRuntimeResource(input: unknown, platform: RuntimePlatform): RuntimeObservationResource {
  try {
    const source = input === undefined ? {} : objectValue(input)
    if (!isPlainObject(source)) throw new DeliveryDataError()
    const state: CloneState = { nodes: 0, seen: new Set<object>() }
    if (Object.keys(source).some(key => !INPUT_KEYS.has(key))) throw new DeliveryDataError()
    const metadata = {
      ...optional(source, 'serviceName', value => boundedText(cloneText(value), 128)),
      ...optional(source, 'serviceVersion', value => boundedText(cloneText(value), 128)),
      ...optional(source, 'environment', value => boundedText(cloneText(value), 128)),
      ...optional(source, 'attributes', value =>
        cloneResourceValue(objectValue(value), 0, state) as Readonly<Record<string, JsonValue>>),
    }
    if (bytes(metadata) > RESOURCE_LIMITS.bytes) throw new DeliveryDataError()
    const resource = Object.freeze({ sdkName: 'ai-agent-sdk' as const, sdkVersion: SDK_VERSION,
      runtime: 'unknown' as const, runtimeId: platform.randomHex(16), ...metadata })
    prepared.add(resource)
    return resource
  } catch { throw new DeliveryDataError() }
}
