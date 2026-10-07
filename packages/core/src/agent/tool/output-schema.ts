/**
 * The subset of JSON Schema a program may rely on for a child's value.
 *
 * Deliberately small. A keyword outside it makes the whole schema
 * `unsupported`: the value is then handed over as unchecked rather than
 * declared valid by a validator that skipped the part it did not understand.
 */
import type { JsonValue } from '../../primitives/index.ts'

export type OutputSchemaVerdict = 'valid' | 'invalid' | 'unsupported'

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', '$comment',
  'deprecated', 'readOnly', 'writeOnly'])
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
  const state = { visits: 0 }
  try {
    return validateNode(schema, value, state) ? 'valid' : 'invalid'
  } catch (error: unknown) {
    if (error instanceof Unsupported) return 'unsupported'
    throw error
  }
}

type SchemaNode = { readonly [key: string]: JsonValue }
type ValidationState = { visits: number }

function validateNode(input: JsonValue, data: JsonValue, state: ValidationState): boolean {
  if (++state.visits > MAX_VISITS) throw new Unsupported('schema check exceeded its visit bound')
  if (input === true) return true
  if (input === false) return false
  if (!isSchemaObject(input)) throw new Unsupported('schema node')
  const node = input as SchemaNode
  validateKeywords(node)
  let valid = validateScalarConstraints(node, data)
  if (Array.isArray(data)) valid = validateArray(node, data, state) && valid
  if (isSchemaObject(data)) {
    valid = validateObject(node, data as Record<string, JsonValue>, state) && valid
  }
  return valid
}

function validateKeywords(node: SchemaNode): void {
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Unsupported(key)
  }
}

function validateScalarConstraints(node: SchemaNode, data: JsonValue): boolean {
  let valid = true
  valid = validateTypeConstraint(node.type, data)
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum)) throw new Unsupported('enum')
    if (!node.enum.some(entry => sameJson(entry, data))) valid = false
  }
  if (node.const !== undefined && !sameJson(node.const, data)) valid = false
  valid = validateNumericBounds(node, data) && valid
  return valid
}

function validateTypeConstraint(type: JsonValue | undefined, data: JsonValue): boolean {
  let valid = true
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (types.length === 0 || !types.every(entry => typeof entry === 'string' && TYPES.has(entry))) {
      throw new Unsupported('type')
    }
    if (!types.some(entry => matchesType(entry as string, data))) valid = false
  }
  return valid
}

function validateNumericBounds(node: SchemaNode, data: JsonValue): boolean {
  for (const key of NUMERIC_KEYWORDS) {
    if (node[key] !== undefined && typeof node[key] !== 'number') throw new Unsupported(key)
  }
  let valid = true
  if (typeof data === 'number') valid = validateNumberBounds(node, data) && valid
  if (typeof data === 'string') valid = validateStringBounds(node, data) && valid
  return valid
}

function validateNumberBounds(node: SchemaNode, data: number): boolean {
  let valid = true
    if (typeof node.minimum === 'number' && data < node.minimum) valid = false
    if (typeof node.maximum === 'number' && data > node.maximum) valid = false
  return valid
}

function validateStringBounds(node: SchemaNode, data: string): boolean {
  let valid = true
    const length = [...data].length
    if (typeof node.minLength === 'number' && length < node.minLength) valid = false
    if (typeof node.maxLength === 'number' && length > node.maxLength) valid = false
  return valid
}

function validateArray(node: SchemaNode, data: readonly JsonValue[], state: ValidationState): boolean {
  let valid = true
  if (typeof node.minItems === 'number' && data.length < node.minItems) valid = false
  if (typeof node.maxItems === 'number' && data.length > node.maxItems) valid = false
  if (node.items === undefined) return valid
  if (Array.isArray(node.items)) throw new Unsupported('tuple items')
  for (const entry of data) if (!validateNode(node.items, entry, state)) valid = false
  return valid
}

function validateObject(node: SchemaNode, data: Record<string, JsonValue>, state: ValidationState): boolean {
  const properties = node.properties
  if (properties !== undefined && !isSchemaObject(properties)) throw new Unsupported('properties')
  let valid = validateRequired(node, data)
  for (const [key, entry] of Object.entries(data)) {
    if (!validateProperty(key, entry, { properties, node, state })) valid = false
  }
  return valid
}

function validateProperty(key: string, entry: JsonValue, context: {
  readonly properties: JsonValue | undefined; readonly node: SchemaNode; readonly state: ValidationState
}): boolean {
  const { properties, node, state } = context
  const declared = properties === undefined ? undefined : (properties as Record<string, JsonValue>)[key]
  if (declared !== undefined && Object.hasOwn(properties as object, key)) return validateNode(declared, entry, state)
  return node.additionalProperties === undefined || validateNode(node.additionalProperties, entry, state)
}

function isSchemaObject(value: JsonValue): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRequired(node: SchemaNode, data: Record<string, JsonValue>): boolean {
  if (node.required === undefined) return true
  if (!Array.isArray(node.required)) throw new Unsupported('required')
  return node.required.every(key => typeof key === 'string' && Object.hasOwn(data, key))
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
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string,
    JsonValue>)[key]!)]))
}

/**
 * Whether every keyword in the schema is inside the subset, without a value.
 * @param schema - The schema to inspect.
 * @returns `true` when {@link checkOutputSchema} can give a definite verdict.
 */
export function outputSchemaSupported(schema: JsonValue): boolean {
  return new SchemaSupport().walk(schema)
}

class SchemaSupport {
  private visits = 0

  walk(node: JsonValue): boolean {
    if (++this.visits > MAX_VISITS) return false
    if (typeof node === 'boolean') return true
    if (!isSchemaObject(node)) return false
    for (const [key, entry] of Object.entries(node)) {
      if (!this.supportsEntry(key, entry)) return false
    }
    return true
  }

  private supportsEntry(key: string, entry: JsonValue): boolean {
    if (ANNOTATIONS.has(key)) return true
    if (!KEYWORDS.has(key)) return false
    if ((NUMERIC_KEYWORDS as readonly string[]).includes(key)) return supportedNumericKeyword(key, entry)
    return this.supportsValue(key, entry)
  }

  private supportsValue(key: string, entry: JsonValue): boolean {
    switch (key) {
      case 'enum': return supportedEnum(entry)
      case 'required': return supportedRequired(entry)
      case 'items': return !Array.isArray(entry) && this.walk(entry)
      case 'additionalProperties': return this.walk(entry)
      case 'properties': return isSchemaObject(entry) && Object.values(entry).every(value => this.walk(value))
      case 'type': return supportedTypes(entry)
      default: return true
    }
  }
}

function supportedNumericKeyword(key: string, entry: JsonValue): boolean {
  if (typeof entry !== 'number' || !Number.isFinite(entry)) return false
  return key === 'minimum' || key === 'maximum' || (Number.isInteger(entry) && entry >= 0)
}

function supportedEnum(entry: JsonValue): boolean {
  return Array.isArray(entry) && entry.length > 0
    && new Set(entry.map(value => JSON.stringify(canonical(value)))).size === entry.length
}

function supportedRequired(entry: JsonValue): boolean {
  return Array.isArray(entry) && entry.every(value => typeof value === 'string')
    && new Set(entry).size === entry.length
}

function supportedTypes(entry: JsonValue): boolean {
  const types = Array.isArray(entry) ? entry : [entry]
  return types.length > 0 && types.every(type => typeof type === 'string' && TYPES.has(type))
    && new Set(types).size === types.length
}
