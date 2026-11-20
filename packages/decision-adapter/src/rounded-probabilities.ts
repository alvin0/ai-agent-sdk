interface ProbabilityBounds { readonly min: number; readonly max: number }
const EPSILON = 1e-9

/** Bounds for provider probabilities rounded independently to two decimal places. */
export function roundedProbabilityBounds(values: readonly number[]): readonly ProbabilityBounds[] | undefined {
  if (values.some(value => Math.abs(value * 100 - Math.round(value * 100)) > EPSILON)) return undefined
  const bounds = values.map(value => ({ min: Math.max(0, value - 0.005), max: Math.min(1, value + 0.005) }))
  const minimum = bounds.reduce((sum, bound) => sum + bound.min, 0)
  const maximum = bounds.reduce((sum, bound) => sum + bound.max, 0)
  return minimum <= 1 + EPSILON && maximum >= 1 - EPSILON ? bounds : undefined
}

export function roundedScoreMatches(score: number, probabilities: readonly number[]): boolean {
  if (Math.abs(score * 100 - Math.round(score * 100)) > EPSILON) return false
  const bounds = roundedProbabilityBounds(probabilities)
  if (bounds === undefined) return false
  const minimum = extremalScore(bounds, false)
  const maximum = extremalScore(bounds, true)
  return score + 0.005 >= minimum - EPSILON && score - 0.005 <= maximum + EPSILON
}

/** Allocate the remaining probability to the lowest/highest levels while preserving sum=1. */
function extremalScore(bounds: readonly ProbabilityBounds[], descending: boolean): number {
  let remaining = 1 - bounds.reduce((sum, bound) => sum + bound.min, 0)
  let score = bounds.reduce((sum, bound, index) => sum + index * bound.min, 0)
  for (let position = 0; position < bounds.length; position++) {
    const index = descending ? bounds.length - 1 - position : position
    const bound = bounds[index]!
    const added = Math.max(0, Math.min(remaining, bound.max - bound.min))
    score += index * added
    remaining -= added
  }
  return score
}
