import type { JsonObject } from '../../primitives/index.ts'
import { defineTool, type ToolDefinition } from './definition.ts'

/** Adapt a schema library once: its JSON Schema and validator share one source. */
export interface RuntimeSchema<T> {
  readonly jsonSchema: JsonObject
  readonly parse: (value: unknown) => T
}

export function defineToolFromSchema<T>(
  schema: RuntimeSchema<T>,
  definition: Omit<ToolDefinition<T>, 'parameters' | 'parse'>,
): ToolDefinition<T> {
  const parse = schema.parse.bind(schema)
  return defineTool({ ...definition, parameters: schema.jsonSchema, parse })
}
