/**
 * How tools are described to a model and how its choice among them is constrained.
 *
 * @module ai-agent-sdk/core/contract/tool
 */

/** JSON-Schema description of one application function executed by the host. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>
}

/** Approximate user location used to improve a provider-native web search. */
export interface WebSearchLocation {
  city?: string
  region?: string
  country?: string
  timezone?: string
}

/** Web search executed inside the provider response, not by the host scheduler. */
export interface NativeWebSearchTool {
  type: 'native'
  name: 'web-search'
  searchContextSize?: 'low' | 'medium' | 'high'
  allowedDomains?: readonly string[]
  blockedDomains?: readonly string[]
  userLocation?: WebSearchLocation
  maxUses?: number
}

/** Image generation executed inside the provider response. */
export interface NativeImageGenerationTool {
  type: 'native'
  name: 'image-generation'
  size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  quality?: 'auto' | 'low' | 'medium' | 'high'
  format?: 'png' | 'jpeg' | 'webp'
  background?: 'auto' | 'transparent' | 'opaque'
  /** Number of progressive images requested while generation is in flight. */
  partialImages?: number
}

/** Merge-extensible semantic vocabulary for tools executed by a provider. */
export interface NativeToolSchemaMap {
  'web-search': NativeWebSearchTool
  'image-generation': NativeImageGenerationTool
}

export type NativeToolName = keyof NativeToolSchemaMap
export type NativeToolSchema = NativeToolSchemaMap[NativeToolName]
export type ModelToolSchema = ToolSchema | NativeToolSchema

export function isNativeToolSchema(tool: ModelToolSchema): tool is NativeToolSchema {
  return 'type' in tool && tool.type === 'native'
}

/**
 * How the model should choose among the supplied tools.
 *
 * `required` means "call some tool"; `{ type: 'tool' }` names exactly one.
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'tool'; name: string }
  | { type: 'native'; name: NativeToolName }
