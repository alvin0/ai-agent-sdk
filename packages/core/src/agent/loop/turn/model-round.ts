import type { RoundResult } from './types.ts'
import type { ModelRoundInput } from './model-round-types.ts'
import { createRoundContext, prepareModelRequest, emitRoundStart } from './model-round-request.ts'
import { streamModelRound } from './model-round-stream.ts'
import { finishModelRound } from './model-round-result.ts'

/** Run one bounded model request, preserving hook, stream and accounting order. */
export async function modelRound(input: ModelRoundInput): Promise<RoundResult> {
  const context = createRoundContext(input)
  const prepared = await prepareModelRequest(context)
  if ('result' in prepared) return prepared.result
  await emitRoundStart(context, prepared.request)
  const stream = await streamModelRound(context, prepared.request)
  return finishModelRound(context, stream)
}
