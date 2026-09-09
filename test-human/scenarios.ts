/** Scenario-specific model controls and user-message construction. */

import type { NativeToolSchema, ToolChoice } from '@alvin0/ai-agent-sdk-core'
import { createTextMessage, createUserMessage, type UserMessage } from '@alvin0/ai-agent-sdk-core'
import type { HumanCliConfig } from './config.ts'
import { loadImageBlock } from './media.ts'

export interface HumanScenarioControls {
  readonly nativeTools: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
}

export function scenarioControls(config: HumanCliConfig): HumanScenarioControls {
  const nativeTools: NativeToolSchema[] = config.scenario === 'web'
    ? [{ type: 'native', name: 'web-search' }]
    : config.scenario === 'deep-research'
      ? [config.provider === 'anthropic'
          ? { type: 'native', name: 'web-search', maxUses: 12 }
          : config.provider === 'openai'
            ? { type: 'native', name: 'web-search', searchContextSize: 'high' }
            : { type: 'native', name: 'web-search' }]
    : config.scenario === 'image-gen'
      ? [{ type: 'native', name: 'image-generation', format: 'png', partialImages: 2 }]
      : []
  if (!config.forceTool) return { nativeTools }
  if (config.scenario === 'web' || config.scenario === 'deep-research') {
    return { nativeTools, toolChoice: { type: 'native', name: 'web-search' } }
  }
  if (config.scenario === 'image-gen') {
    return { nativeTools, toolChoice: { type: 'native', name: 'image-generation' } }
  }
  return { nativeTools }
}

export async function scenarioUserMessage(
  config: HumanCliConfig,
  prompt: string,
  attachVisionImage: boolean,
): Promise<UserMessage> {
  if (config.scenario !== 'vision' || !attachVisionImage) return createTextMessage(prompt)
  if (config.image === undefined) throw new Error('vision scenario requires an image source')
  return createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: prompt }, await loadImageBlock(config.image)],
  })
}
