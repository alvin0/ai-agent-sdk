/**
 * The streaming pipeline's entry into the shared transport chain.
 *
 * Two properties define it, and both are about what happens while a consumer is
 * still pulling. The provider attempt stays open for the whole stream, because a
 * stream that fails halfway through is one attempt with a failure — not a success
 * followed by a mystery. And every pull is raced against the fused signal, so a
 * decoder that blocks on a provider which has stopped sending still surrenders when
 * the caller aborts, the deadline fires, or the consumer walks away.
 *
 * What `decode` sees is a response that already cleared every guard in
 * {@link withTransportSession}: bounded body, no redirect, 2xx, attempt open. What
 * it owns is the format — media type, framing, termination.
 *
 * @module ai-agent-sdk/providers/transport/stream
 */

import { withAbortSignal } from './http.ts'
import {
  withTransportSession,
  type HttpTransportRequestInput,
  type HttpTransportSession,
} from './session.ts'

/**
 * Send one request and stream whatever `decode` makes of the response.
 *
 * @param input - request facts captured from one connection snapshot.
 * @param decode - turns a guarded response into the pipeline's own values.
 * @returns the decoded values, with the attempt held open until iteration ends.
 */
export function transportStream<T>(
  input: HttpTransportRequestInput,
  decode: (session: HttpTransportSession) => AsyncIterable<T>,
): AsyncGenerator<T> {
  return withTransportSession(
    input,
    session => withAbortSignal(decode(session), session.signal),
  )
}
