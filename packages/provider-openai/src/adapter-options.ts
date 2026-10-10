import {
  endpointHeaders,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  type ChatCompletionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'

import type { OpenAiAdapterOptions, OpenAiCatalogModel,
  OpenAiChatCompletionsCompat ,
} from './adapter-types.ts'
import { OPENAI_BASE_URL } from './constants.ts'

export function sharedOptions<Token>(
  options: Omit<OpenAiAdapterOptions, 'apiKey'> & { apiKey: Token }, models: readonly OpenAiCatalogModel[] | undefined,
) {
  return {
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: { kind: 'bearer' as const, token: options.apiKey, label: 'the `apiKey` option' },
    headers: endpointHeaders(options.headers, {
      ...(options.organization === undefined ? {} : { 'openai-organization': options.organization }),
      ...(options.project === undefined ? {} : { 'openai-project': options.project }),
    }),
    ...(models === undefined ? {} : { models }),
    ...requestOptions(options), ...modelOptions(options), ...transportLimits(options),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
}

function requestOptions(options: Omit<OpenAiAdapterOptions, 'apiKey'>) {
  return {
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.transformRequest === undefined ? {} : { transformRequest: options.transformRequest }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  }
}

function modelOptions(options: Omit<OpenAiAdapterOptions, 'apiKey'>) {
  return {
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
  }
}

const CHAT_COMPLETIONS_REASONING_FORMATS = new Set(['openai', 'deepseek', false])

export function chatCompletionsDialectOf(
  compat: OpenAiChatCompletionsCompat | undefined,
  promptCacheKey: string | undefined,
): Partial<ChatCompletionsDialect> {
  validateReasoningFormat(compat)
  return {
    // A JS caller (or one that fought past TypeScript with `as any`) mistyping
    // a value from a DIFFERENT protocol — Anthropic's `'thinking-budget'`, for
    // instance — would otherwise fall through `reasoningFieldsOf`'s `=== false`
    // / `=== 'openai'` checks in serialize.ts and silently behave as
    // `'deepseek'` instead of failing loudly.
    reasoningFormat: compat?.reasoningFormat ?? 'openai',
    ...(compat === undefined ? {} : chatFields(compat)),
    // The resolved key — explicit, auto-generated, or the older `compat`-only
    // spelling — always wins over `compat.promptCacheKey` restated here, since
    // both already fed into the SAME resolution in `effectivePromptCacheKey`.
    ...promptCacheKey === undefined ? {} : { promptCacheKey },
  }
}

function validateReasoningFormat(compat: OpenAiChatCompletionsCompat | undefined) {
  if (compat?.reasoningFormat !== undefined && !CHAT_COMPLETIONS_REASONING_FORMATS.has(compat.reasoningFormat)) {
    throw new TypeError(
      `Chat Completions reasoningFormat must be 'openai', 'deepseek', or false, received `
      + `${JSON.stringify(compat.reasoningFormat)}`,
    )
  }
}

function chatFields(compat: OpenAiChatCompletionsCompat) {
  return {
    ...compat.maxTokensField === undefined ? {} : { maxTokensField: compat.maxTokensField },
    ...compat.systemRole === undefined ? {} : { systemRole: compat.systemRole },
    ...compat.structuredOutputs === undefined ? {} : { structuredOutputs: compat.structuredOutputs },
    ...compat.tools === undefined ? {} : { tools: compat.tools },
    ...compat.parallelToolCalls === undefined ? {} : { parallelToolCalls: compat.parallelToolCalls },
    ...compat.streamUsage === undefined ? {} : { streamUsage: compat.streamUsage },
    ...compat.stop === undefined ? {} : { stop: compat.stop },
    ...compat.seed === undefined ? {} : { seed: compat.seed },

  }
}
function transportLimits(options: Omit<OpenAiAdapterOptions, 'apiKey'>) {
  return {
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents },
    ...options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },

  }
}
