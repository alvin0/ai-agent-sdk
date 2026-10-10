import { ModelError } from '@alvin0/ai-agent-sdk-core'
import type { UsageCounters } from '@alvin0/ai-agent-sdk-core/provider'
import type { CapturedLlmRequest, LlmResponseOptions } from './llm-response.ts'
import { exactKeys } from './llm-schema.ts'
import { decisionError, record, validateDecisionResult } from './validation.ts'
interface LlmOutput { readonly finished: boolean; readonly tools: readonly string[];
  readonly texts: readonly string[]; readonly usage: UsageCounters | undefined }
export function decodeLlmOutput(output: LlmOutput, captured: CapturedLlmRequest, options: LlmResponseOptions) {
  const input = captured.input
  const { mode, evidence } = options
  if (!output.finished) throw new ModelError('LLM decision stream ended without finish', 'STREAM_CLOSED')
  if (mode === 'tool' ? output.tools.length !== 1 : output.tools.length !== 0 ||
    output.texts.length === 0) decisionError('Missing or ambiguous LLM decision output', true)
  const text = mode === 'tool' ? output.tools[0]! : output.texts.join('')
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { return decisionError('LLM decision returned invalid JSON', true) }
  const root = record(parsed, 'LLM decision output', true)
  exactKeys(root, ['answers'])
  const rawAnswers = record(root.answers, 'LLM decision answers', true)
  exactKeys(rawAnswers, Object.keys(input.questions))
  const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
    const answer = record(rawAnswers[id], 'LLM decision answer', true)
    const expected = answerKeys(question.type, evidence)
    exactKeys(answer, expected)
    if (question.type === 'boolean' && evidence && answer.value !== ((
      answer.probabilityTrue as number) >= 0.5)) decisionError('LLM boolean does not agree with its evidence', true)
    const score = question.type === 'score' && evidence
      ? Object.entries(record(answer.probabilities, 'probabilities', true)).reduce((sum, [level, p]) =>
        sum + Number(level) * (p as number), 0)
      : undefined
    return [id, { ...answer, ...(score === undefined ? {} : { score }), type: question.type, ...(
      evidence ? { probabilitySource: 'model-generated' as const } : {}) }]
  }))
  return validateDecisionResult({ model: captured.generation.model, answers, ...(output.usage === undefined ? {
  } : { usage: output.usage }) }, input.questions)
}

function answerKeys(type: string, evidence: boolean): string[] {
  let keys: string[]
  switch (type) {
    case 'choice': keys = ['choice']; break
    case 'score': keys = evidence ? [] : ['score']; break
    default: keys = ['value']
  }
  if (evidence) keys.push(...(type === 'boolean' ? ['probabilityTrue'] : ['probabilities', 'confidence']))
  return keys
}
