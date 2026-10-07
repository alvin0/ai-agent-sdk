import {
  isNativeToolSchema, type ModelOutputFormat, type ModelToolSchema, type NativeWebSearchTool,
  type ToolChoice, type ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type { WireCacheControl, WireOutputConfig, WireThinking, WireTool, WireToolChoice } from './wire.ts'
import type { ThinkingBudgets, AnthropicSerializeOptions, AnthropicReasoningFormat } from './serialize-types.ts'

export function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  // "call some tool" is spelled `any` here, not `required`.
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.type === 'native' ? nativeToolName(choice.name) : choice.name }
}

export function functionTool(tool: ToolSchema): WireTool {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

export function nativeToolName(name: string): string {
  if (name === 'web-search') return 'web_search'
  return name.replaceAll('-', '_')
}

export function webSearchTool(tool: NativeWebSearchTool): WireTool {
  if (tool.allowedDomains !== undefined && tool.blockedDomains !== undefined) {
    throw new ModelError(
      'Anthropic web search accepts allowedDomains or blockedDomains, not both',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    ...tool.maxUses === undefined ? {} : { max_uses: tool.maxUses },
    ...tool.allowedDomains === undefined ? {} : { allowed_domains: [...tool.allowedDomains] },
    ...tool.blockedDomains === undefined ? {} : { blocked_domains: [...tool.blockedDomains] },
    ...tool.userLocation === undefined ? {} : {
      user_location: { type: 'approximate', ...tool.userLocation },
    },
  }
}

export function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  if (tool.name === 'web-search') return webSearchTool(tool)
  throw new ModelError(
    `Anthropic does not support the provider-native tool '${tool.name}'`,
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

export function thinkingFromBudget(
  effort: string | undefined,
  maxTokens: number,
  budgets: ThinkingBudgets,
): WireThinking | undefined {
  if (effort === undefined) return undefined
  const requested = budgets[effort]
  if (requested === undefined || requested <= 0) return { type: 'disabled' }
  // Leave at least a quarter of the budget for the visible answer.
  const capped = Math.min(requested, Math.floor(maxTokens * 0.75))
  // This API's own floor for extended thinking.
  return capped < 1_024 ? { type: 'disabled' } : { type: 'enabled', budget_tokens: capped }
}

export function outputConfig(
  format: ModelOutputFormat | undefined,
  effort: string | undefined,
): WireOutputConfig | undefined {
  const formatPart = format === undefined || format.type === 'text'
    ? undefined
    : { type: 'json_schema' as const, schema: format.schema }
  if (formatPart === undefined && effort === undefined) return undefined
  return {
    ...(formatPart === undefined ? {} : { format: formatPart }),
    ...(effort === undefined ? {} : { effort }),
  }
}

export function cacheControlOf(options: AnthropicSerializeOptions): WireCacheControl | undefined {
  if (options.promptCaching !== true) return undefined
  return { type: 'ephemeral', ...(options.promptCachingTtl === undefined ? {} : { ttl: options.promptCachingTtl }) }
}

export function toolsOf(request: ProtocolRequest, cacheControl: WireCacheControl | undefined): WireTool[] | undefined {
  const tools = request.options.tools
  if (tools === undefined || tools.length === 0) return undefined
  const result = tools.map(toolOf)
  if (cacheControl !== undefined) {
    const lastTool = result.at(-1)
    if (lastTool !== undefined) lastTool.cache_control = cacheControl
  }
  return result
}

export function reasoningOptions(
  request: ProtocolRequest, options: AnthropicSerializeOptions, maxTokens: number,
) {
  const reasoningFormat = options.reasoningFormat ?? 'output-config'
  const effort = request.options.reasoningEffort === undefined ? undefined : String(request.options.reasoningEffort)
  const thinking = thinkingOf(reasoningFormat, { options, effort, maxTokens })
  const output = outputConfig(request.options.outputFormat, reasoningFormat === 'output-config' ? effort : undefined)
  return {
    ...thinking === undefined ? {} : { thinking },
    ...output === undefined ? {} : { output_config: output },
  }
}

function thinkingOf(
  format: AnthropicReasoningFormat,
  context: { options: AnthropicSerializeOptions; effort: string | undefined; maxTokens: number },
): WireThinking | undefined {
  const { options, effort, maxTokens } = context
  if (format === 'thinking-budget') return thinkingFromBudget(effort, maxTokens, options.budgets)
  if (options.thinking === undefined) return undefined
  return options.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' }
}

export function samplingOptions(request: ProtocolRequest) {
  const call = request.options
  return {
    ...call.temperature === undefined ? {} : { temperature: call.temperature },
    ...call.topP === undefined ? {} : { top_p: call.topP },
    ...call.stop === undefined || call.stop.length === 0 ? {} : { stop_sequences: [...call.stop] },
  }
}
