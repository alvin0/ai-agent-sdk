import type { ModelInvocationContext, UsageCounters } from '@alvin0/ai-agent-sdk-core/provider'

export type DecisionJson = null | boolean | number | string | readonly DecisionJson[] | {
  readonly [key: string]: DecisionJson }
export type DecisionDescription = string | readonly DecisionJson[] | { readonly [key: string]: DecisionJson }
export interface ChoiceQuestion<Options extends string = string> {
  readonly type: 'choice'
  readonly instructions: DecisionDescription
  readonly options: Readonly<Record<Options, DecisionDescription | null>>
}
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: DecisionDescription
  /** Ordered rubric, indexed from zero. */
  readonly levels: readonly DecisionDescription[]
}
export interface BooleanQuestion {
  readonly type: 'boolean'
  readonly instructions: DecisionDescription
  readonly criteria?: { readonly true?: DecisionDescription; readonly false?: DecisionDescription }
}
export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | BooleanQuestion
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>
/** Evidence provenance is explicit; none of these tags promises empirical calibration. */
export type DecisionProbabilitySource = 'provider' | 'token-logprobs' | 'model-generated'
export interface DecisionEvidence {
  readonly confidence?: number
  readonly probabilitySource?: DecisionProbabilitySource
}
export interface ChoiceAnswer<Options extends string = string> extends DecisionEvidence {
  readonly type: 'choice'
  readonly choice: Options
  readonly probabilities?: Readonly<Record<Options, number>>
}
export interface ScoreAnswer extends DecisionEvidence {
  readonly type: 'score'
  /** Expected zero-based rubric index; fractional values are valid. */
  readonly score: number
  readonly probabilities?: Readonly<Record<string, number>>
}
export interface BooleanAnswer extends DecisionEvidence {
  readonly type: 'boolean'
  readonly value: boolean
  readonly probabilityTrue?: number
}
export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | BooleanAnswer
export type DecisionAnswerFor<Q extends DecisionQuestion> = Q extends ChoiceQuestion<infer O>
  ? ChoiceAnswer<O> : Q extends ScoreQuestion ? ScoreAnswer : BooleanAnswer
export type DecisionAnswers<Q extends DecisionQuestions> = { readonly [K in keyof Q]: DecisionAnswerFor<Q[K]> }
export interface DecisionInput<Q extends DecisionQuestions = DecisionQuestions> {
  readonly state: DecisionDescription
  readonly questions: Q
  readonly signal?: AbortSignal
  /** Includes preparation, attempts and backoff. Default: 30 seconds. */
  readonly timeoutMs?: number
}
export interface DecisionRequest extends DecisionInput {
  readonly provider: string
  readonly model: string
}
export interface DecisionResult<Q extends DecisionQuestions = DecisionQuestions> {
  readonly model: string
  readonly answers: DecisionAnswers<Q>
  readonly usage?: UsageCounters
  readonly providerRequestId?: string
}
export interface DecisionCapabilities {
  readonly questionTypes?: readonly DecisionQuestion['type'][]
  readonly maxChoiceOptions?: number
  readonly maxScoreLevels?: number
  readonly maxQuestions?: number
}
export interface DecisionModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly capabilities?: DecisionCapabilities
}
export interface DecisionModelHandle {
  evaluate<Q extends DecisionQuestions>(input: DecisionInput<Q>,
    context?: ModelInvocationContext): Promise<DecisionResult<Q>>
}
export interface DecisionModelTarget { readonly provider: string; readonly model: string }
export function choiceQuestion<const O extends string>(instructions: DecisionDescription,
  options: Readonly<Record<O, DecisionDescription | null>>): ChoiceQuestion<O> {
  return { type: 'choice', instructions, options }
}
export function scoreQuestion(instructions: DecisionDescription,
  levels: readonly DecisionDescription[]): ScoreQuestion {
  return { type: 'score', instructions, levels }
}
export function booleanQuestion(instructions: DecisionDescription,
  criteria?: BooleanQuestion['criteria']): BooleanQuestion {
  return { type: 'boolean', instructions, ...(criteria === undefined ? {} : { criteria }) }
}
