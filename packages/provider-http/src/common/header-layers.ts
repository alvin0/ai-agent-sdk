import { AgentSdkError } from '@alvin0/ai-agent-sdk-core/provider'
import { HTTP_PROVIDER_ERROR_CODES } from './config.ts'

export type HeaderLayer = 'transport' | 'sdk-attribution' | 'wire-protocol' | 'endpoint' | 'auth'

export interface HeaderLayerInput {
  readonly layer: HeaderLayer
  readonly headers: Readonly<Record<string, string>>
}

export interface HeaderMergeResult {
  readonly headers: Readonly<Record<string, string>>
  readonly sensitiveHeaderNames: readonly string[]
}

export const DEFAULT_TRANSPORT_HEADERS = Object.freeze({
  'content-type': 'application/json',
  accept: 'text/event-stream',
})

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_TRANSPORT_NAMES = new Set([
  'connection', 'content-length', 'host', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const TRANSPORT_OWNED_NAMES = new Set(['accept', 'content-type'])
const SDK_OWNED_NAMES = new Set(['user-agent'])
const SDK_OWNED_PREFIXES = ['x-ai-agent-sdk-'] as const
const SENSITIVE_NAME = /authorization|api[-_]?key|token|secret|cookie|account[-_]?id|signature/i

/** Conservative fallback used in addition to exact authentication provenance. */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_NAME.test(name)
}

/** Detach one layer without applying ownership rules that need all layers present. */
export function captureHeaderLayer(input: HeaderLayerInput): HeaderLayerInput {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  const source = headerRecord(input.headers)
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') throw headerError('Header names must be strings', 'HEADER_INVALID')
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw headerError('Header values must not use accessors', 'HEADER_INVALID')
    }
    const name = key.toLowerCase()
    validateHeaderShape(name, descriptor.value)
    if (Object.hasOwn(output, name)) {
      throw headerError('Header names must be unique case-insensitively', 'HEADER_COLLISION')
    }
    output[name] = descriptor.value
  }
  return Object.freeze({ layer: input.layer, headers: Object.freeze(output) })
}

/** Validate five case-insensitive ownership layers and return one detached snapshot. */
export function mergeHeaderLayers(layers: readonly HeaderLayerInput[]): HeaderMergeResult {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  const owners = new Map<string, HeaderLayer>()
  const sensitive = new Set<string>()

  for (const raw of layers) {
    const input = captureHeaderLayer(raw)
    for (const [name, value] of Object.entries(input.headers)) {
      const first = owners.get(name)
      if (first !== undefined) {
        throw headerError(
          `Header ownership collision between ${first} and ${input.layer}`,
          'HEADER_COLLISION',
        )
      }
      validateHeaderOwnership(name, input.layer)
      owners.set(name, input.layer)
      output[name] = value
      if (input.layer === 'auth') sensitive.add(name)
    }
  }

  return Object.freeze({
    headers: Object.freeze(output),
    sensitiveHeaderNames: Object.freeze([...sensitive]),
  })
}

function headerRecord(value: unknown): object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw headerError('Headers must be a record', 'HEADER_INVALID')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw headerError('Headers must be a plain record', 'HEADER_INVALID')
  }
  return value
}

function validateHeaderShape(name: string, value: unknown): asserts value is string {
  if (!HEADER_NAME.test(name) || name.length > 256 || typeof value !== 'string'
    || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw headerError('Header name or value is invalid', 'HEADER_INVALID')
  }
}

function validateHeaderOwnership(name: string, layer: HeaderLayer): void {
  if (FORBIDDEN_TRANSPORT_NAMES.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) {
    throw headerError('Header name is reserved by the transport', 'HEADER_RESERVED')
  }
  if (TRANSPORT_OWNED_NAMES.has(name) && layer !== 'transport') {
    throw headerError('Header name is owned by the transport layer', 'HEADER_RESERVED')
  }
  if (SDK_OWNED_NAMES.has(name) && layer !== 'sdk-attribution') {
    throw headerError('Header name is owned by SDK attribution', 'HEADER_RESERVED')
  }
  if (SDK_OWNED_PREFIXES.some(prefix => name.startsWith(prefix)) && layer !== 'sdk-attribution') {
    throw headerError('Header prefix is owned by SDK attribution', 'HEADER_RESERVED')
  }
  if (isSensitiveHeaderName(name) && layer !== 'auth') {
    throw headerError('Credential headers must be supplied by auth', 'HEADER_RESERVED')
  }
}

function headerError(
  message: string,
  key: 'HEADER_INVALID' | 'HEADER_RESERVED' | 'HEADER_COLLISION',
): AgentSdkError {
  return new AgentSdkError(message, HTTP_PROVIDER_ERROR_CODES[key])
}
