/**
 * The redirect guard every Copilot HTTP call passes through.
 *
 * `redirect: 'manual'` on the request is only half of a no-follow policy: it
 * stops the runtime from following a hop, but it does not stop the CALLER from
 * treating the result as a normal response. This module is the other half — it
 * turns every shape a redirect can take into a structured error before a second
 * request can be dispatched.
 *
 * There are four shapes, and a check for only one of them is a hole:
 *
 * - **A 3xx status** — the ordinary case, visible because `redirect: 'manual'`
 *   surfaces the response instead of following it.
 * - **`type === 'opaqueredirect'`** — what a browser returns instead of the 3xx,
 *   with the status flattened to `0` and the headers stripped. A status-only
 *   check misses this entirely.
 * - **`redirected === true`** — a hop that was already followed, by a runtime or
 *   an intermediary that ignored `redirect: 'manual'`.
 * - **`response.url` differing from the requested URL** — the last resort, for a
 *   runtime that reports neither of the flags above but still moved the request.
 *
 * The body is RELEASED before the error is thrown. A rejected response whose body
 * is never cancelled holds a socket open for as long as the runtime keeps the
 * stream alive, so the guard cannot leave that to the caller's `finally`.
 *
 * @module ai-agent-sdk/providers/copilot/no-follow
 */

import { AgentSdkError, waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { COPILOT_ERROR_CODES } from './error-codes.ts'

/**
 * The Copilot HTTP call sites, named so an error says which one refused the hop.
 *
 * All seven are listed because the redirect guard covers all seven: the two
 * device-flow legs, the token exchange, the catalog, both generation endpoints
 * and the embedding endpoint (Requirements 3.8, 7.8). A call site that is not on
 * this list has no name to report, which is the point — adding an endpoint means
 * naming it here, and naming it here means it went through {@link
 * rejectCopilotRedirect}.
 */
export type CopilotHttpOperation =
  | 'device code'
  | 'device token'
  | 'token exchange'
  | 'model catalog'
  | 'responses'
  | 'chat completions'
  | 'embeddings'

/**
 * Reject every redirect shape Web fetch exposes, before any second request.
 *
 * @param response - the response as returned by a `redirect: 'manual'` fetch.
 * @param requestedUrl - the absolute URL that was requested, for the
 *   `response.url` comparison.
 * @param operation - which Copilot call site is refusing the hop.
 * @param teardownTimeoutMs - bound on the body cancellation, so a stream that
 *   never settles cannot hold the rejection open forever.
 * @returns nothing when the response is not a redirect in any of its four shapes.
 * @throws AgentSdkError with `COPILOT_REDIRECT_REJECTED` when it is.
 */
export async function rejectCopilotRedirect(
  response: Response,
  requestedUrl: string,
  operation: CopilotHttpOperation,
  teardownTimeoutMs: number,
): Promise<void> {
  const redirectStatus = response.status >= 300 && response.status < 400
  const responseUrlChanged = response.url.length > 0 && response.url !== requestedUrl
  if (response.type !== 'opaqueredirect' && response.redirected !== true
    && !redirectStatus && !responseUrlChanged) return
  if (response.body !== null) {
    await waitForSettlement(response.body.cancel().catch(() => undefined), teardownTimeoutMs)
  }
  throw new AgentSdkError(
    `Copilot ${operation} rejected a redirect before following it`,
    COPILOT_ERROR_CODES.REDIRECT_REJECTED,
  )
}
