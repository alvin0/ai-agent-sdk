import { createModelContextPolicy } from '@alvin0/ai-agent-sdk-provider-http'
import type { ModelContextPolicyOptions } from '@alvin0/ai-agent-sdk-provider-http'

// Verified 2026-09-13: https://ai.google.dev/gemini-api/docs/pricing
// Google publishes separate input/output limits; do not invent a combined ceiling.
const PRO = { defaultContextWindow: 200_000, standardPriceInputTokens: 200_000 }
export function geminiContextPolicy(options: ModelContextPolicyOptions) {
  return createModelContextPolicy(
    options.baseUrl === undefined || options.baseUrl.replace(/\/$/, '') === 'https://generativelanguage.googleapis.com/v1beta'
      ? {
          'gemini-3.1-pro-preview': PRO, 'gemini-3.1-pro-preview-customtools': PRO, 'gemini-2.5-pro': PRO,
          'gemini-2.5-flash': { defaultContextWindow: 1_000_000 },
          'gemini-3-flash-preview': { defaultContextWindow: 1_000_000 },
        }
      : {}, options.models, options.defaultContextWindow)
}
