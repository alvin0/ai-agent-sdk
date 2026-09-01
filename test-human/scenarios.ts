/** Scenario-specific model controls and user-message construction. */

import type { NativeToolSchema, ToolChoice } from '../src/core/contract/tool.ts'
import { createTextMessage, createUserMessage, type UserMessage } from '../src/core/message/message.ts'
import type { HumanCliConfig } from './config.ts'
import { loadImageBlock } from './media.ts'

export interface HumanScenarioControls {
  readonly nativeTools: readonly NativeToolSchema[]
  readonly toolChoice?: ToolChoice
}

export function scenarioControls(config: HumanCliConfig): HumanScenarioControls {
  const nativeTools: NativeToolSchema[] = config.scenario === 'web'
    ? [{ type: 'native', name: 'web-search' }]
    : config.scenario === 'image-gen'
      ? [{ type: 'native', name: 'image-generation', format: 'png', partialImages: 2 }]
      : []
  if (!config.forceTool) return { nativeTools }
  if (config.scenario === 'web') {
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
