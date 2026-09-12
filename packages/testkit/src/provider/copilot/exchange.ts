/**
 * The token exchange a Copilot conformance run has to answer before any
 * generation request goes out.
 *
 * Every other provider in this repository authenticates with the credential it
 * already holds. Copilot holds a LONG-LIVED GitHub token and has to trade it for
 * a short-lived API token first, over a plain JSON request to a different origin
 * (`api.github.com`). So a scripted fetch written for the generation leg alone
 * never sees the request the adapter actually makes first, and the run fails on
 * an exchange rather than on anything the conformance contract is about.
 *
 * {@link withCopilotTokenExchange} closes that gap: it answers the exchange
 * locally and delegates everything else, unchanged, to the scripted fetch the
 * generic conformance fixture supplies. The exchange therefore never touches the
 * fixture's dispatch counters, which is what keeps the retry and cancellation
 * scenarios counting only generation attempts.
 *
 * @module ai-agent-sdk/testkit/provider/copilot/exchange
 */

/** Path fragment identifying the exchange request, on any GitHub API base. */
export const COPILOT_TOKEN_EXCHANGE_PATH = '/copilot_internal/v2/token'

/** The long-lived GitHub token a conformance credential store holds. */
export const COPILOT_CONFORMANCE_GITHUB_TOKEN = 'ghu_conformance_github_token'

/** The short-lived API token the exchange hands back, kept distinct from the tier above. */
export const COPILOT_CONFORMANCE_API_TOKEN = 'conformance-copilot-api-token'

/** How long the exchanged token stays valid; long enough that no run refreshes. */
const EXCHANGE_LIFETIME_SECONDS = 1_800

/**
 * Wrap a scripted fetch so the Copilot token exchange is answered locally.
 * @param inner - the fetch the conformance fixture scripted for generation.
 * @returns a fetch that answers the exchange and delegates everything else.
 */
export function withCopilotTokenExchange(
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (requestUrl(input).includes(COPILOT_TOKEN_EXCHANGE_PATH)) return exchangeResponse()
    return await inner(input, init)
  }
}

/** Read the target URL out of any of the three shapes `fetch` accepts. */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** The exchange answer: an API token and the expiry the cache reads. */
function exchangeResponse(): Response {
  return new Response(JSON.stringify({
    token: COPILOT_CONFORMANCE_API_TOKEN,
    expires_at: Math.floor(Date.now() / 1_000) + EXCHANGE_LIFETIME_SECONDS,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
