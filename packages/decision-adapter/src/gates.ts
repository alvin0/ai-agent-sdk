import type { BooleanAnswer, ChoiceAnswer, DecisionProbabilitySource } from './types.ts'
import { decisionError } from './validation.ts'

export type DecisionGateResult<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | { readonly status: 'abstained'; readonly reason: 'missing-evidence' | 'untrusted-evidence' | 'below-threshold' }
export interface DecisionEvidencePolicy {
  /** Defaults to native provider evidence only. No source implies abstention. */
  readonly allowedSources?: readonly DecisionProbabilitySource[]
}
export interface ChoiceGatePolicy extends DecisionEvidencePolicy {
  readonly minConfidence?: number
  readonly minProbability?: number
  /** Selected probability minus the largest competing probability. */
  readonly minMargin?: number
}
export interface BooleanGatePolicy extends DecisionEvidencePolicy {
  readonly falseMax: number
  readonly trueMin: number
}
const abstain = (reason: 'missing-evidence' | 'untrusted-evidence' | 'below-threshold') => Object.freeze({
  status: 'abstained' as const, reason })
const bounded = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value >= 0 && value <= 1
function sourceGate(source: DecisionProbabilitySource | undefined, policy: DecisionEvidencePolicy) {
  const allowed = policy.allowedSources ?? ['provider']
  if (!Array.isArray(allowed) || allowed.some(item => !['provider', 'token-logprobs',
    'model-generated'].includes(item))) decisionError('Invalid decision evidence sources')
  if (source === undefined) return abstain('missing-evidence')
  return allowed.includes(source) ? undefined : abstain('untrusted-evidence')
}
/** Thresholds are application policy, never a provider-independent calibration guarantee. */
export function gateChoice<O extends string>(answer: ChoiceAnswer<O>, policy: ChoiceGatePolicy): DecisionGateResult<O> {
  const thresholds = [policy.minConfidence, policy.minProbability, policy.minMargin]
  if (thresholds.every(value => value === undefined) || thresholds.some(value => value !== undefined &&
    !bounded(value))) decisionError('Choice gate requires valid explicit thresholds')
  const source = sourceGate(answer.probabilitySource, policy)
  if (source) return source
  const confidence = confidenceGate(answer.confidence, policy.minConfidence)
  if (confidence) return confidence
  const probabilities = choiceProbabilityGate(answer, policy)
  if (probabilities) return probabilities
  return Object.freeze({ status: 'accepted', value: answer.choice })
}
/** A deliberate uncertainty interval replaces an implicit 0.5 action threshold. */
export function gateBoolean(answer: BooleanAnswer, policy: BooleanGatePolicy): DecisionGateResult<boolean> {
  if (!bounded(policy.falseMax) || !bounded(policy.trueMin) ||
    policy.falseMax >= policy.trueMin) decisionError('Boolean gate requires falseMax < trueMin within [0, 1]')
  const source = sourceGate(answer.probabilitySource, policy)
  if (source) return source
  if (!bounded(answer.probabilityTrue)) return abstain('missing-evidence')
  if (answer.probabilityTrue <= policy.falseMax) return Object.freeze({ status: 'accepted', value: false })
  if (answer.probabilityTrue >= policy.trueMin) return Object.freeze({ status: 'accepted', value: true })
  return abstain('below-threshold')
}

function confidenceGate(confidence: number | undefined, minimum: number | undefined) {
  if (minimum !== undefined) {
    if (!bounded(confidence)) return abstain('missing-evidence')
    if (confidence < minimum) return abstain('below-threshold')
  }
  return undefined
}

function choiceProbabilityGate<O extends string>(answer: ChoiceAnswer<O>, policy: ChoiceGatePolicy) {
  if (policy.minProbability !== undefined || policy.minMargin !== undefined) {
    const probabilities = answer.probabilities
    if (!probabilities || !Object.hasOwn(probabilities, answer.choice) || !bounded(
      probabilities[answer.choice])) return abstain('missing-evidence')
    const selected = probabilities[answer.choice]
    if (policy.minProbability !== undefined && selected < policy.minProbability) return abstain('below-threshold')
    return choiceMarginGate(probabilities, answer.choice, selected, policy.minMargin)
  }
  return undefined
}

function choiceMarginGate(
  probabilities: Readonly<Record<string, number>>, choice: string, selected: number, minimum: number | undefined,
) {
  if (minimum !== undefined) {
    const competing = Object.entries<number>(probabilities).filter(([key]) => key !== choice).map((
      [, value]) => value)
    if (!competing.length || competing.some(value => !bounded(value))) return abstain('missing-evidence')
    if (selected - Math.max(...competing) < minimum) return abstain('below-threshold')
  }
  return undefined
}
