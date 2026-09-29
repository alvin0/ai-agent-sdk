/**
 * The subset of JSON Schema a program may rely on for a child's value.
 *
 * Deliberately small. A keyword outside it makes the whole schema
 * `unsupported`: the value is then handed over as unchecked rather than
 * declared valid by a validator that skipped the part it did not understand.
 */
import type { JsonValue } from '../../primitives/index.ts'

export type OutputSchemaVerdict = 'valid' | 'invalid' | 'unsupported'

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly'])
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
])
const NUMERIC_KEYWORDS = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const MAX_VISITS = 100_000

class Unsupported extends Error {}

/**
 * @param schema - A captured, bounded JSON Schema object.
 * @param value - The finalized structured value.
 * @returns Whether the value satisfies the schema, or that the schema is outside the subset.
 */
export function checkOutputSchema(schema: JsonValue, value: JsonValue): OutputSchemaVerdict {
  // Support belongs to the entire contract, including branches absent from
  // this value. Never promise validation after skipping an exotic branch.
  if (!outputSchemaSupported(schema)) return 'unsupported'
  let visits = 0
  const visit = (input: JsonValue, data: JsonValue): boolean => {
    if (++visits > MAX_VISITS) throw new Unsupported('schema check exceeded its visit bound')
    if (input === true) return true
    if (input === false) return false
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Unsupported('schema node')
    const node = input as { readonly [key: string]: JsonValue }
    for (const key of Object.keys(node)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Unsupported(key)
    }
    let ok = true
    const type = node.type
    if (type !== undefined) {
      const types = Array.isArray(type) ? type : [type]
      if (types.length === 0 || !types.every(entry => typeof entry === 'string' && TYPES.has(entry))) throw new Unsupported('type')
      if (!types.some(entry => matchesType(entry as string, data))) ok = false
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) throw new Unsupported('enum')
      if (!node.enum.some(entry => sameJson(entry, data))) ok = false
    }
    if (node.const !== undefined && !sameJson(node.const, data)) ok = false
    // A malformed bound is the schema's fault, not the value's: never call it invalid.
    for (const key of NUMERIC_KEYWORDS) if (node[key] !== undefined && typeof node[key] !== 'number') throw new Unsupported(key)
    if (typeof data === 'number') {
      if (typeof node.minimum === 'number' && data < node.minimum) ok = false
      if (typeof node.maximum === 'number' && data > node.maximum) ok = false
    }
    if (typeof data === 'string') {
      const length = [...data].length
      if (typeof node.minLength === 'number' && length < node.minLength) ok = false
      if (typeof node.maxLength === 'number' && length > node.maxLength) ok = false
    }
    if (Array.isArray(data)) {
      if (typeof node.minItems === 'number' && data.length < node.minItems) ok = false
      if (typeof node.maxItems === 'number' && data.length > node.maxItems) ok = false
      if (node.items !== undefined) {
        if (Array.isArray(node.items)) throw new Unsupported('tuple items')
        for (const entry of data) if (!visit(node.items, entry)) ok = false
      }
    }
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const properties = node.properties
      if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
        throw new Unsupported('properties')
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required)) throw new Unsupported('required')
        for (const key of node.required) if (typeof key !== 'string' || !Object.hasOwn(data, key)) ok = false
      }
      for (const [key, entry] of Object.entries(data)) {
        const declared = properties === undefined ? undefined : (properties as Record<string, JsonValue>)[key]
        if (declared !== undefined && Object.hasOwn(properties as object, key)) {
          if (!visit(declared, entry)) ok = false
        } else if (node.additionalProperties !== undefined && !visit(node.additionalProperties, entry)) {
          ok = false
        }
      }
    }
    return ok
  }
  try {
    return visit(schema, value) ? 'valid' : 'invalid'
  } catch (error: unknown) {
    if (error instanceof Unsupported) return 'unsupported'
    throw error
  }
}

function matchesType(type: string, data: JsonValue): boolean {
  switch (type) {
    case 'null': return data === null
    case 'boolean': return typeof data === 'boolean'
    case 'string': return typeof data === 'string'
    case 'number': return typeof data === 'number'
    case 'integer': return typeof data === 'number' && Number.isInteger(data)
    case 'array': return Array.isArray(data)
    default: return typeof data === 'object' && data !== null && !Array.isArray(data)
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, JsonValue>)[key]!)]))
}

/**
 * Whether every keyword in the schema is inside the subset, without a value.
 * @param schema - The schema to inspect.
 * @returns `true` when {@link checkOutputSchema} can give a definite verdict.
 */
export function outputSchemaSupported(schema: JsonValue): boolean {
  let visits = 0
  const walk = (node: JsonValue): boolean => {
    if (++visits > MAX_VISITS) return false
    if (typeof node === 'boolean') return true
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
    for (const [key, entry] of Object.entries(node)) {
      if (ANNOTATIONS.has(key)) continue
      if (!KEYWORDS.has(key)) return false
      if ((NUMERIC_KEYWORDS as readonly string[]).includes(key)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) return false
        if (key !== 'minimum' && key !== 'maximum' && (!Number.isInteger(entry) || entry < 0)) return false
      }
      if (key === 'enum' && (!Array.isArray(entry) || entry.length === 0
        || new Set(entry.map(value => JSON.stringify(canonical(value)))).size !== entry.length)) return false
      if (key === 'required' && (!Array.isArray(entry) || !entry.every(value => typeof value === 'string')
        || new Set(entry).size !== entry.length)) return false
      if (key === 'items' && (Array.isArray(entry) || !walk(entry))) return false
      if (key === 'additionalProperties' && !walk(entry)) return false
      if (key === 'properties') {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
        if (!Object.values(entry).every(walk)) return false
      }
      if (key === 'type') {
        const types = Array.isArray(entry) ? entry : [entry]
        if (types.length === 0 || !types.every(type => typeof type === 'string' && TYPES.has(type))
          || new Set(types).size !== types.length) return false
      }
    }
    return true
  }
  return walk(schema)
}
