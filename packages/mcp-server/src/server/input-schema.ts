import { fromJsonSchema } from '@modelcontextprotocol/server'
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims'

type InputSchema = Parameters<typeof fromJsonSchema>[0]
type CapturedSchema = ReturnType<typeof fromJsonSchema>

const schemas = new WeakMap<object, { readonly serialized: string; readonly value: CapturedSchema }>()

/** Reuse a schema's validator while its source lives, refreshing after caller edits. */
export function captureInputSchema<T>(
  schema: InputSchema, owner: object = schema,
): ReturnType<typeof fromJsonSchema<T>> {
  const serialized = JSON.stringify(schema)
  const previous = schemas.get(owner)
  if (previous?.serialized === serialized) return previous.value as ReturnType<typeof fromJsonSchema<T>>
  // The upstream default is a module-wide AJV cache. A fresh clone on every
  // HTTP request otherwise leaves every compiled schema in that cache forever.
  // This exported shim selects the upstream Node, browser or Worker validator.
  const value = fromJsonSchema<T>(structuredClone(schema), new DefaultJsonSchemaValidator())
  schemas.set(owner, { serialized, value })
  return value
}
