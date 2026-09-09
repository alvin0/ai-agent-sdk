import { MODEL_ERROR_CODES, ModelError, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { ProviderProtocolChunk } from './types.ts'

/**
 * Enforce the provider-neutral stream terminal contract.
 *
 * The finish chunk is held until the translator ends. That makes it impossible
 * for a custom protocol to expose a finish and then append more output. Earlier
 * output remains streaming; a truncated response after visible output is still
 * surfaced and therefore cannot be retried by the outer retry adapter.
 */
export async function* requireTerminalFinish(
  source: AsyncIterable<ProviderProtocolChunk>,
  displayName: string,
): AsyncGenerator<ProviderProtocolChunk> {
  let finish: Extract<StreamChunk, { readonly type: 'finish' }> | undefined
  for await (const chunk of source) {
    if (finish !== undefined) {
      throw new ModelError(
        `${displayName} protocol emitted output after its terminal finish`,
        MODEL_ERROR_CODES.MALFORMED_RESPONSE,
      )
    }
    if (chunk.type === 'finish') {
      finish = chunk
      continue
    }
    yield chunk
  }
  if (finish === undefined) {
    throw new ModelError(
      `${displayName} response ended before a terminal finish`,
      MODEL_ERROR_CODES.STREAM_CLOSED,
    )
  }
  yield finish
}
