export const TOOL_DEFINITION_LIMITS = Object.freeze({
  tools: 1_024,
  nameBytes: 256,
  descriptionBytes: 16 * 1024,
  schemaBytes: 256 * 1024,
  schemaDepth: 32,
  schemaNodes: 16_384,
  schemaFields: 512,
  schemaArrayItems: 1_024,
  schemaKeyBytes: 256,
})

export const TOOL_REGISTRY_ERROR_CODES = Object.freeze({
  DUPLICATE_TOOL: 'DUPLICATE_TOOL',
  INVALID_TOOL: 'INVALID_TOOL',
  UNKNOWN_TOOL_FILTER: 'UNKNOWN_TOOL_FILTER',
} as const)
