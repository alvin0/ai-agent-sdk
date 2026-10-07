/**
 * The one risky chain every HTTP pipeline in this package runs, written once.
 *
 * Everything here is a step that is invisible when it works and expensive when it
 * is missing: fusing the caller's cancellation with our own teardown controller and
 * the request deadline, bounding the outbound body, letting a diagnostic observer
 * look at the request without letting it veto dispatch, opening a provider attempt
 * before the socket and closing it exactly once afterwards, refusing a redirect
 * instead of replaying credentials to wherever it points, turning a non-2xx into a
 * stable code with `retry-after` and a request id attached, and releasing the
 * response body when the consumer walks away early.
 *
 * A second copy of this chain for embedding would be a second chance to forget one
 * of those steps — which is precisely why the chain, and not the decoding, is what
 * gets shared. What a pipeline supplies is only `decode`: what to do with a
 * response that already passed every guard above.
 *
 * The classification order at the bottom is part of the contract and is deliberately
 * not simplified: a fired deadline outranks an abort the caller did not request,
 * an aborted fused signal outranks a transport failure, and an admission refusal
 * from `startProviderAttempt` is rethrown untouched so audit mode's decision is not
 * relabelled as a transport error.
 *
 * @module ai-agent-sdk/providers/transport/session
 */

import { TransportRequest } from './request-lifecycle.ts'
import type { HttpTransportRequestInput, HttpTransportSession } from './session-types.ts'

export type * from './session-types.ts'

/**
 * Run one request through the shared safety chain and stream `use`'s output.
 *
 * The generator shape matters: the provider attempt stays open, and the response
 * body stays owned, for as long as the consumer keeps pulling. A consumer that
 * stops early aborts the teardown controller in `finally`, which is what tears down
 * an in-flight response instead of leaking the connection.
 * @param input - the request facts, all captured from one connection snapshot.
 * @param use - decodes a guarded response; its failures are classified here.
 * @returns whatever `use` yields, unchanged.
 */
export async function* withTransportSession<T>(
  input: HttpTransportRequestInput,
  use: (session: HttpTransportSession) => AsyncIterable<T>,
): AsyncGenerator<T> {
  yield* new TransportRequest(input).run(use)
}
