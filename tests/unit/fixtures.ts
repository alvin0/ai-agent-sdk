/** Shared builders so serializer tests read as data, not as setup. */

import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { ProviderRequest } from '@alvin0/ai-agent-sdk-provider-http'

/** Build a `ProviderRequest` around the parts a serializer actually reads. */
export function providerRequest(
  options: Omit<GenerateOptions, 'provider' | 'model'> & Partial<Pick<GenerateOptions, 'provider' | 'model'>>,
  maxTokens = 4_096,
): ProviderRequest {
  const provider = options.provider ?? 'test'
  const model = options.model ?? 'test-model'
  const resolved: ResolvedModelInfo = {
    provider,
    id: model,
    name: model,
    inputModalities: ['text', 'image'],
  }
  return {
    options: { ...options, provider, model },
    model: resolved,
    connection: {
      baseUrl: 'https://example.invalid',
      headers: {},
      streamIdleTimeoutMs: 1_000,
      retryPolicy: resolveRetryPolicy(undefined, 'fixture'),
      models: [],
      defaultMaxTokens: maxTokens,
      defaultContextWindow: 100_000,
    },
    maxTokens,
  }
}
