/** Provider-neutral controls for the model's visible text output. */

import type { JsonObject } from '../primitives/json.ts'

/** Ordinary unconstrained model text. */
export interface TextOutputFormat {
  readonly type: 'text'
}

/** JSON text constrained by a caller-owned JSON Schema. */
export interface JsonSchemaOutputFormat {
  readonly type: 'json_schema'
  /** Stable schema identifier. Required by providers such as OpenAI Responses. */
  readonly name: string
  /** Provider-supported JSON Schema. Provider-specific subsets still apply. */
  readonly schema: Readonly<JsonObject>
}

export type ModelOutputFormat = TextOutputFormat | JsonSchemaOutputFormat
