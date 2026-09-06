import type { ModelOutputFormat } from '../../contract/output-format.ts'
import { snapshotJsonObject } from '../../primitives/json-snapshot.ts'
import { TOOL_DEFINITION_LIMITS } from '../tool/config.ts'

const NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** Validate, detach, bound, and freeze output configuration at definition time. */
export function captureOutputFormat(value: ModelOutputFormat | undefined): ModelOutputFormat | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const type = ownData(value, 'type')
  if (type === 'text') {
    exactKeys(value, ['type'])
    return Object.freeze({ type })
  }
  if (type !== 'json_schema') throw invalid()
  exactKeys(value, ['type', 'name', 'schema'])
  const name = ownData(value, 'name')
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid()
  const schema = snapshotJsonObject(ownData(value, 'schema'), {
    maxObjectFields: TOOL_DEFINITION_LIMITS.schemaFields,
    maxArrayItems: TOOL_DEFINITION_LIMITS.schemaArrayItems,
    maxDepth: TOOL_DEFINITION_LIMITS.schemaDepth,
    maxNodes: TOOL_DEFINITION_LIMITS.schemaNodes,
    maxKeyBytes: TOOL_DEFINITION_LIMITS.schemaKeyBytes,
    maxBytes: TOOL_DEFINITION_LIMITS.schemaBytes,
  })
  return Object.freeze({ type, name, schema })
}

function ownData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined || !('value' in descriptor)) throw invalid()
  return descriptor.value
}

function exactKeys(source: object, allowed: readonly string[]): void {
  const expected = new Set(allowed)
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !expected.has(key))) throw invalid()
}

function invalid(): TypeError {
  return new TypeError('agent outputFormat must be text or a bounded JSON Schema with a valid name')
}
