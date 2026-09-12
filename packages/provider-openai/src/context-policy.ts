import { createModelContextPolicy } from '@alvin0/ai-agent-sdk-provider-http'
import type { ModelContextPolicyOptions } from '@alvin0/ai-agent-sdk-provider-http'

// Verified 2026-09-13: https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
const GPT_56 = { defaultContextWindow: 272_000, maxContextWindow: 1_050_000, standardPriceInputTokens: 272_000 }
export function openAiContextPolicy(options: ModelContextPolicyOptions) {
  return createModelContextPolicy(
    options.baseUrl === undefined || options.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1'
      ? { 'gpt-5.6-luna': GPT_56, 'gpt-5.6-sol': GPT_56, 'gpt-5.6-terra': GPT_56 }
      : {}, options.models, options.defaultContextWindow)
}
