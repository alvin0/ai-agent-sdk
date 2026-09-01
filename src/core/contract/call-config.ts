/**
 * The subset of a request that behaves like connection state rather than
 * per-message content: route, model, effort, and sampling scalars.
 *
 * Isolating these is what makes the prepare/dispatch split in the registry
 * meaningful  Ethe registry can prove that the configuration it resolved
 * capabilities against is the same one being dispatched.
 *
 * @module ai-agent-sdk/core/contract/call-config
 */

import type { ReasoningEffortId } from '../primitives/brand.ts'

/**
 * Route, model, effort, and sampling scalars of one request. Every field maps
 * 1:1 onto the same-named {@link GenerateOptions} field.
 */
export interface CallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: readonly string[]
}

/**
 * Which effective config fields came from adapter resolution rather than from
 * the caller's request.
 *
 * Reported so a caller can tell "I chose 4096 output tokens" from "the adapter
 * chose 4096 for me", which matters when surfacing effective settings.
 */
export interface CallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * Field-wise equality over {@link CallConfig}.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field matches, comparing `stop` element-wise.
 */
export function callConfigEquals(a: CallConfig, b: CallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.topP !== b.topP
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((value, index) => value === b.stop?.[index])
}
