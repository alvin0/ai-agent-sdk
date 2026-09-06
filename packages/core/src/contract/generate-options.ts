/**
 * One fully assembled model request — the single input every adapter receives.
 *
 * @module ai-agent-sdk/core/contract/generate-options
 */

import type { Message } from '../message/message.ts'
import type { ReasoningEffortId } from '../primitives/brand.ts'
import type { ModelToolSchema, ToolChoice } from './tool.ts'
import type { ModelOutputFormat } from './output-format.ts'

/** One fully assembled model request. */
export interface GenerateOptions {
  /** Registered provider route, selecting the adapter instance. */
  provider: string
  /**
   * Exact model id, passed to the provider verbatim.
   *
   * Required, with no SDK-side default. Provider model lineups turn over faster
   * than this package's release cadence, so any built-in default would eventually
   * name a retired model and break for everyone who trusted it.
   */
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /** Ordered conversation messages, exactly as the provider will see them. */
  messages: readonly Message[]
  /** System prompt text; adapters map it to the provider's system slot. */
  system?: string
  /** Host functions and provider-native tools offered to the model. */
  tools?: readonly ModelToolSchema[]
  /** Tool-selection constraint; omission means the provider's own default. */
  toolChoice?: ToolChoice
  /** Visible response format; omission uses the provider's ordinary text default. */
  outputFormat?: ModelOutputFormat
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Stop sequences; generation halts on any of them, and the string is excluded from output. */
  stop?: readonly string[]
  signal?: AbortSignal
}
