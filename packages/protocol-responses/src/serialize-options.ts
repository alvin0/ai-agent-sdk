import type { ProtocolRequest } from './contract.ts'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import {
  isNativeToolSchema, type ModelOutputFormat, type ModelToolSchema, type NativeImageGenerationTool,
  type NativeWebSearchTool, type ToolChoice, type ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import type { ResponsesDialect, WireTool, WireToolChoice, WireTextControls } from './wire.ts'

export function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (typeof choice === 'string') return choice
  if (choice.type === 'native') return { type: nativeWireType(choice.name) }
  return { type: 'function', name: choice.name }
}

export function functionTool(tool: ToolSchema): WireTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    // Strict mode imposes real JSON-Schema restrictions (no optional fields
    // without null, `additionalProperties: false` required). Opting a caller's
    // schema in silently would turn a working tool into a request rejection.
    strict: false,
    parameters: tool.parameters,
  }
}

export function nativeWireType(name: string): string {
  if (name === 'web-search') return 'web_search'
  if (name === 'image-generation') return 'image_generation'
  return name.replaceAll('-', '_')
}

export function webSearchTool(tool: NativeWebSearchTool): WireTool {
  if (tool.blockedDomains !== undefined) {
    throw new ModelError(
      'OpenAI Responses web search does not support blockedDomains; use allowedDomains',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  if (tool.maxUses !== undefined) {
    throw new ModelError(
      'OpenAI Responses web search does not support maxUses',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    type: 'web_search',
    ...tool.searchContextSize === undefined ? {} : { search_context_size: tool.searchContextSize },
    ...tool.allowedDomains === undefined ? {} : { filters: { allowed_domains: [...tool.allowedDomains] } },
    ...tool.userLocation === undefined ? {} : {
      user_location: { type: 'approximate', ...tool.userLocation },
    },
  }
}

export function imageGenerationTool(tool: NativeImageGenerationTool): WireTool {
  return {
    type: 'image_generation',
    ...tool.size === undefined ? {} : { size: tool.size },
    ...tool.quality === undefined ? {} : { quality: tool.quality },
    ...tool.format === undefined ? {} : { output_format: tool.format },
    ...tool.background === undefined ? {} : { background: tool.background },
    ...tool.partialImages === undefined ? {} : { partial_images: tool.partialImages },
  }
}

export function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  if (tool.name === 'web-search') return webSearchTool(tool)
  return imageGenerationTool(tool)
}

export function textControls(
  format: ModelOutputFormat | undefined,
  dialect: ResponsesDialect,
): WireTextControls | undefined {
  if (format === undefined) return undefined
  if (format.type === 'text') {
    return dialect.structuredOutputs ? { format: { type: 'text' } } : undefined
  }
  if (!dialect.structuredOutputs) {
    throw new ModelError(
      'This Responses endpoint does not support JSON Schema output',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    format: {
      type: 'json_schema',
      name: format.name,
      schema: format.schema,
      strict: true,
    },
  }
}

export function toolsOptions(request: ProtocolRequest) {
  const options = request.options
  const tools = options.tools === undefined || options.tools.length === 0 ? undefined : options.tools.map(toolOf)
  return {
    ...tools === undefined ? {} : { tools, parallel_tool_calls: true },
    ...options.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(options.toolChoice) },
  }
}

export function reasoningOptions(request: ProtocolRequest, dialect: ResponsesDialect) {
  const effort = request.options.reasoningEffort
  if (effort === undefined && dialect.reasoningSummary === undefined) return {}
  return { reasoning: {
    ...effort === undefined ? {} : { effort: String(effort) },
    ...dialect.reasoningSummary === undefined ? {} : { summary: dialect.reasoningSummary },
  } }
}

export function dialectOptions(request: ProtocolRequest, dialect: ResponsesDialect) {
  const text = textControls(request.options.outputFormat, dialect)
  return {
    ...text === undefined ? {} : { text },
    ...dialect.store === undefined ? {} : { store: dialect.store },
    ...dialect.include.length === 0 ? {} : { include: [...dialect.include] },
    ...dialect.promptCacheKey === undefined ? {} : { prompt_cache_key: dialect.promptCacheKey },
    ...dialect.maxOutputTokens && request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {},
  }
}

export function samplingOptions(request: ProtocolRequest, dialect: ResponsesDialect) {
  const options = request.options
  return {
    ...dialect.sampling && options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...dialect.sampling && options.topP !== undefined ? { top_p: options.topP } : {},
  }
}
