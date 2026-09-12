import { createModelContextPolicy } from '@alvin0/ai-agent-sdk-provider-http'
import type { ModelContextPolicyOptions } from '@alvin0/ai-agent-sdk-provider-http'

// Verified 2026-09-13: https://platform.claude.com/docs/en/build-with-claude/context-windows
const STANDARD_1M = Object.fromEntries([
  'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
  'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1',
  'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-preview',
].map(id => [id, { defaultContextWindow: 1_000_000, maxContextWindow: 1_000_000 }]))

export function anthropicContextPolicy(options: ModelContextPolicyOptions) {
  return createModelContextPolicy(
    options.baseUrl === undefined || options.baseUrl.replace(/\/$/, '') === 'https://api.anthropic.com'
      ? STANDARD_1M : {}, options.models, options.defaultContextWindow)
}
