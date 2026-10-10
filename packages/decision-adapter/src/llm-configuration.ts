import type { LlmDecisionAdapterOptions } from './llm.ts'
import { decisionError, identifier, snapshotJson } from './validation.ts'
export function captureLlmGeneration(value: LlmDecisionAdapterOptions['generation']) {
  const generation = value === undefined ? undefined : snapshotJson(value)
  if (generation) {
    if (Object.keys(generation).some(key => !['temperature', 'topP', 'maxTokens',
      'reasoningEffort'].includes(key))) decisionError('Unsupported LLM decision generation option')
    const { temperature, topP, maxTokens, reasoningEffort } = generation
    validateSampling(temperature, 2, 'temperature')
    validateSampling(topP, 1, 'topP')
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) decisionError(
      'Invalid LLM decision token cap')
    if (reasoningEffort !== undefined) identifier(reasoningEffort, 'Reasoning effort')
  }
  return generation
}
export function llmResponseLimit(value: number | undefined): number {
  const limit = value ?? 2_097_152
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16_777_216) decisionError(
    'Invalid LLM decision response limit')
  return limit
}

function validateSampling(value: number | undefined, maximum: number, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum)) decisionError(
    `Invalid LLM decision ${label}`)
}
