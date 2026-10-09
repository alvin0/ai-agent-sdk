import { modelRound } from './model-round.ts'

export interface RequestRetryState {
  consecutiveFailures: number
  grantedRetries: number
}

export async function requestModelRound(
  state: RequestRetryState, ...args: Parameters<typeof modelRound>
): ReturnType<typeof modelRound> {
  const round = await modelRound(...args)
  if (round.finish.kind === 'error') state.consecutiveFailures++
  else if (round.finish.kind !== 'aborted') state.consecutiveFailures = 0
  return round
}
