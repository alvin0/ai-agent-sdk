import { ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import {
  validateDecisionResult, type DecisionAnswer, type DecisionInput, type DecisionResult,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { object, responseUsage, sameDescription } from './response.ts'

export function decodeTypesafeResult(value: unknown, input: DecisionInput): DecisionResult {
  const raw = object(value)
  const rawAnswers = object(raw.answers)
  // Validate wire identifiers/types BEFORE projecting, so surplus answers cannot disappear.
  if (Object.keys(rawAnswers).length !== Object.keys(input.questions).length) throw new ModelError(
    'Unexpected TypeSafe answer ids', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<string, DecisionAnswer>
  for (const [id, question] of Object.entries(input.questions)) {
    if (!Object.hasOwn(rawAnswers, id)) throw new ModelError('Missing TypeSafe answer',
      MODEL_ERROR_CODES.MALFORMED_RESPONSE)
    const answer = object(rawAnswers[id])
    answers[id] = decodeAnswer(question, answer)
  }
  const usage = responseUsage(raw)
  return validateDecisionResult({
    model: raw.model, answers,
    ...(usage === undefined ? {} : { usage }),
  }, input.questions)
}

function decodeAnswer(
  question: DecisionInput['questions'][string], answer: Record<string, unknown>,
): DecisionAnswer {
  const evidence = {
    probabilitySource: 'provider' as const,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence as number }),
  }
  switch (question.type) {
    case 'choice':
      assertChoiceAnswer(answer)
      return { type: 'choice', choice: answer.choice as string,
        probabilities: answer.probabilities as Record<string, number>, ...evidence }
    case 'score': {
      assertScoreAnswer(answer, question.levels)
      return { type: 'score', score: answer.score as number,
        probabilities: answer.probabilities as Record<string, number>, ...evidence }
    }
    case 'boolean':
      if (answer.type !== 'noul') throw new ModelError('Invalid TypeSafe boolean answer',
        MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      return { type: 'boolean', value: (answer.noul as number) >= 0.5,
        probabilityTrue: answer.noul as number, probabilitySource: 'provider' }
  }
}

function assertChoiceAnswer(answer: Record<string, unknown>): void {
  if (answer.type !== 'choice' || answer.probabilities === undefined ||
    answer.confidence === undefined) throw new ModelError('Invalid TypeSafe choice answer',
      MODEL_ERROR_CODES.MALFORMED_RESPONSE)
}

function assertScoreAnswer(answer: Record<string, unknown>, levels: readonly unknown[]): void {
  if (answer.type !== 'score' || answer.probabilities === undefined ||
    answer.confidence === undefined) throw new ModelError('Invalid TypeSafe score answer',
      MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  const legend = object(answer.legend)
  if (Object.keys(legend).length !== levels.length || levels.some((level, i) => !Object.hasOwn(
    legend, String(i)) || !sameDescription(level, legend[String(i)]))) throw new ModelError(
      'Invalid TypeSafe score legend', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
}
