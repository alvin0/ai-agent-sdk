import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import {
  MEMORY_ERROR_CODES, MEMORY_LIMITS, MEMORY_OPERATION_ERROR_CODES, MEMORY_STORE_API_VERSION,
} from './config.ts'
import type {
  CapturedMemoryBinding, MemoryBinding, MemoryCommitInput, MemoryCommitResult,
  MemoryLoadResult, MemoryStore, MemoryStoreDefinition, MemoryStoreOptions,
} from './types.ts'

const BINDING_KEYS = new Set(['store', 'bindingId', 'scope', 'requirement'])

/** Side-effect-free author helper. It captures methods but never freezes the caller's store. */
export function defineMemoryStore(definition: MemoryStoreDefinition): MemoryStore {
  return captureStore(definition, false)
}

export function captureMemoryBinding(value: unknown): CapturedMemoryBinding {
  try {
    const source = exactObject(value, BINDING_KEYS)
    const store = captureStore(ownData(source, 'store'), true)
    const bindingId = boundedText(ownData(source, 'bindingId'), MEMORY_LIMITS.identityBytes)
    const requirement = ownData(source, 'requirement')
    if (requirement !== 'required' && requirement !== 'best-effort') throw invalidBinding()
    const scope = captureScope(ownData(source, 'scope'))
    return Object.freeze({ store, bindingId, scope, requirement })
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw invalidBinding()
  }
}

function captureStore(value: unknown, requireMarker: boolean): MemoryStore {
  try {
    const source = objectValue(value)
    if (requireMarker) {
      if (ownData(source, 'kind') !== 'memory-store') {
        throw new AgentSdkError('Memory store kind is unsupported', MEMORY_OPERATION_ERROR_CODES.KIND_MISMATCH)
      }
      if (ownData(source, 'apiVersion') !== MEMORY_STORE_API_VERSION) {
        throw new AgentSdkError('Memory store API version is unsupported', MEMORY_OPERATION_ERROR_CODES.API_UNSUPPORTED)
      }
    }
    const id = boundedText(ownData(source, 'id'), MEMORY_LIMITS.identityBytes)
    const loadMethod = method(source, 'load')
    const commitMethod = method(source, 'commit')
    const load = (key: string, options: MemoryStoreOptions): Promise<MemoryLoadResult | undefined> =>
      Reflect.apply(loadMethod, source, [key, options]) as Promise<MemoryLoadResult | undefined>
    const commit = (input: MemoryCommitInput, options: MemoryStoreOptions): Promise<MemoryCommitResult> =>
      Reflect.apply(commitMethod, source, [input, options]) as Promise<MemoryCommitResult>
    return Object.freeze({ kind: 'memory-store', apiVersion: MEMORY_STORE_API_VERSION, id, load, commit })
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw new AgentSdkError('Memory store definition is invalid', MEMORY_OPERATION_ERROR_CODES.STORE_INVALID)
  }
}

function captureScope(value: unknown): MemoryBinding['scope'] {
  const source = objectValue(value)
  const kind = ownData(source, 'kind')
  if (kind === 'conversation') {
    exactKeys(source, new Set(['kind', 'namespace']))
    return Object.freeze({ kind, namespace: boundedText(ownData(source, 'namespace'), MEMORY_LIMITS.scopeValueBytes) })
  }
  if (kind === 'fixed') {
    exactKeys(source, new Set(['kind', 'key', 'sharedAcrossSessions']))
    if (ownData(source, 'sharedAcrossSessions') !== true) {
      throw new AgentSdkError('Fixed memory scope requires explicit cross-session sharing', MEMORY_ERROR_CODES.INVALID_SCOPE)
    }
    return Object.freeze({ kind, key: boundedText(ownData(source, 'key'), MEMORY_LIMITS.scopeValueBytes), sharedAcrossSessions: true })
  }
  throw new AgentSdkError('Memory scope is invalid', MEMORY_ERROR_CODES.INVALID_SCOPE)
}

function exactObject(value: unknown, keys: ReadonlySet<string>): object {
  const source = objectValue(value)
  exactKeys(source, keys)
  return source
}

function exactKeys(value: object, allowed: ReadonlySet<string>): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) throw new TypeError('Unsupported field')
}

function method(value: object, key: string): Function {
  let result: unknown
  try { result = Reflect.get(value, key) } catch { throw new TypeError('Method capture failed') }
  if (typeof result !== 'function') throw new TypeError('Method is invalid')
  return result
}

function invalidBinding(): AgentSdkError {
  return new AgentSdkError('Memory binding is invalid', MEMORY_OPERATION_ERROR_CODES.BINDING_INVALID)
}
