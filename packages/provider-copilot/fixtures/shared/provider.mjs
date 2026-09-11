import { copilotPlugin, memoryCopilotCredentialStore } from '@alvin0/ai-agent-sdk-provider-copilot'

export const providerId = 'copilot'

/** The long-lived GitHub token; the value the packed run proves never reaches an event. */
export const expectedCredential = 'ghu_packed_copilot_secret'

/** The short-lived API token the exchange hands back, kept distinct from the tier above. */
const apiToken = 'packed-copilot-api-secret'

/**
 * Copilot reports TWO credential operations where a single-tier provider reports
 * one: the resolve the transport asks for, and the token exchange inside it.
 * Each one opens and closes an observation, so the run emits four events.
 */
export const expectedCredentialEvents = 4

/**
 * The Copilot route, with the token exchange answered locally.
 *
 * The shared smoke fixture replaces `globalThis.fetch` with an SSE responder, and
 * Copilot is the one provider that has to make a JSON request BEFORE the stream:
 * the exchange turns the stored GitHub token into a short-lived API token
 * (Requirement 3.1). So this fixture injects a `fetch` that answers the exchange
 * and delegates everything else to whatever `globalThis.fetch` is at call time —
 * which keeps the generation leg identical to the other packed providers.
 */
export const createPlugin = () => copilotPlugin({
  authStore: memoryCopilotCredentialStore({
    version: 1,
    github: { token: expectedCredential },
  }),
  models: [],
  fetch: async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url
    if (url.includes('/copilot_internal/v2/token')) return exchangeResponse()
    return globalThis.fetch(input, init)
  },
})

/**
 * The exchange answer, assembled by hand rather than with `new Response(...)`.
 *
 * The packed fixtures null `globalThis.Buffer` to prove the Universal packages
 * never reach for it, and constructing a real `Response` inside Node pulls in a
 * body implementation that DOES — so building one here would fail the fixture for
 * a reason that has nothing to do with the code under test. The same duck type
 * the shared smoke fixture uses for the stream is what the bounded reader needs.
 */
function exchangeResponse() {
  const payload = JSON.stringify({
    token: apiToken,
    expires_at: Math.floor(Date.now() / 1_000) + 1_800,
  })
  const encoder = new TextEncoder()
  return {
    type: 'basic',
    redirected: false,
    url: '',
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      },
    }),
  }
}

/**
 * Chat Completions frames: `packed-model` carries no `/responses` prefix and the
 * catalog is empty, so the router lands on `/chat/completions` (Requirement 9.1).
 * Usage arrives after the terminal finish, on a chunk with no choices, which is
 * how the endpoint reports it.
 */
export const frames = [
  {
    id: 'chatcmpl-packed',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-packed',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'packed provider completed' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-packed',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'chatcmpl-packed',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  },
]
