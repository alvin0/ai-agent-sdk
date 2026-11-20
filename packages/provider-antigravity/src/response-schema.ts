import { ModelError } from '@alvin0/ai-agent-sdk-core'

function invalid(reason: string): never {
  throw new ModelError(`Antigravity response schema: ${reason}`, 'INVALID_REQUEST')
}

function schemaObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('expected a schema object')
  return value as Record<string, unknown>
}

/** Expand local JSON Schema references for the Cloud Code responseSchema field. */
export function antigravityResponseSchema(input: Record<string, unknown>): Record<string, unknown> {
  const definitions = schemaObject(input.$defs ?? {})
  let nodes = 0
  const expand = (value: unknown, depth: number): Record<string, unknown> => {
    if (++nodes > 2048 || depth > 64) return invalid('reference expansion exceeds supported limits')
    const schema = schemaObject(value)
    if (depth > 0 && Object.hasOwn(schema, '$defs')) return invalid('nested definition scopes are unsupported')
    if (schema.$ref !== undefined) {
      if (Object.keys(schema).some(key => key !== '$ref' && key !== '$defs')) return invalid('unsupported $ref sibling')
      const key = definitionKey(schema.$ref)
      if (!Object.hasOwn(definitions, key)) return invalid('unknown local definition')
      return expand(definitions[key], depth + 1)
    }
    const child = (part: unknown) => expand(part, depth + 1)
    return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$defs')
      .map(([key, part]) => [key, schemaField(key, part, child)]))
  }
  return expand(input, 0)
}

function definitionKey(ref: unknown): string {
  if (typeof ref !== 'string' || !/^#\/\$defs\/([^/~]|~[01])+$/.test(ref)) {
    return invalid('only references to root $defs are supported')
  }
  return ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~')
}

function schemaField(key: string, value: unknown, child: (value: unknown) => Record<string, unknown>): unknown {
  if (key === 'properties') return Object.fromEntries(Object.entries(schemaObject(value))
    .map(([name, property]) => [name, child(property)]))
  if (key === 'items' || (key === 'additionalProperties' && typeof value === 'object')) return child(value)
  if (key === 'anyOf' && Array.isArray(value)) return value.map(child)
  return value
}
