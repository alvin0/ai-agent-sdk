import { type ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { observeCredentialOperation } from '@alvin0/ai-agent-sdk-provider-http'
import {
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS, requireGitHubToken, shouldExchange, type CopilotCredentialSnapshot,
} from './auth.ts'
import { COPILOT_DEFAULT_REQUEST_TIMEOUT_MS, positiveSafeInteger, raceAbort } from './common/http.ts'
import type { CopilotGitHubToken } from './common/store-types.ts'
import { COPILOT_PROVIDER_ID } from './exchange-types.ts'
import type {
  CopilotApiToken, CopilotTokenCacheEntry, CopilotTokenCache, CopilotTokenCacheOptions,
} from './exchange-types.ts'
import { exchangeCopilotToken } from './exchange-operation.ts'

/**
 * Build a token cache over one set of exchange settings.
 *
 * ## The mistake this is written to avoid
 *
 * The shared exchange gets its OWN `AbortController` plus its own deadline, and
 * NEVER any single caller's signal. Were the caller's signal handed to it, the
 * first caller to abort would cancel the exchange every other caller is waiting
 * on, and those callers would fail for a reason that has nothing to do with them.
 * Instead each caller — the one that started the exchange included — races the
 * shared promise against its OWN signal: an aborted caller leaves, and the
 * exchange still completes for everyone else (Property 18).
 *
 * The observation therefore counts exchanges actually DISPATCHED rather than
 * callers served, which is what makes the coalescing observable instead of merely
 * claimed (Property 52). It is recorded with the `'refresh'` operation name: that
 * parameter's union is closed at `'resolve' | 'refresh' | 'login'`, widening it
 * would change a public type of `provider-http`, and Requirement 18.4 forbids
 * that — see DD-7.
 *
 * ## Two paths deliberately absent
 *
 * There is no revision-conflict recovery, unlike `provider-codex`. That path
 * exists there because a Codex refresh token rotates and is single-use, so a lost
 * race destroys a credential. A `GitHub_User_Token` does not rotate and an
 * exchange does not consume it, so two racing processes simply exchange twice —
 * and a branch no situation reaches is a branch nothing verifies (DD-8).
 *
 * Nothing here writes to a store. The `Copilot_Api_Token` is never persisted: it
 * lives ~25 minutes, so persisting it would add a second secret on disk, a second
 * write path, and a new state to reason about, to save one request inside a
 * 25-minute window (DD-9, Requirement 3.3).
 *
 * A failure is returned to every waiting caller as-is and never retried here — an
 * endpoint that rejected the credential will reject it again, and this layer has
 * no way to change that (Requirement 5.8, Property 19).
 * @param options - exchange settings, the observation provider name, the margin
 *   and the clock. `options.signal` is deliberately IGNORED for the exchange
 *   itself; per-caller cancellation travels through `operation.signal`.
 * @returns a cache over a single credential slot.
 */
export function createCopilotTokenCache(
  options: CopilotTokenCacheOptions = {},
): CopilotTokenCache {
  const provider = options.providerId ?? COPILOT_PROVIDER_ID
  const now = options.now ?? (() => Date.now())
  const marginMs = options.marginMs === undefined
    ? COPILOT_TOKEN_EXCHANGE_MARGIN_MS
    : positiveSafeInteger(options.marginMs, 'marginMs')
  const state: CacheState = { entry: undefined, inflight: undefined, inflightToken: undefined, ticket: 0 }
  return {
    async acquire(
      source: CopilotCredentialSnapshot,
      operation: CredentialOperationOptions,
      context?: ModelInvocationContext,
    ): Promise<CopilotApiToken> {
      operation.signal.throwIfAborted()
      const github = requireGitHubToken(source.file, source.label)
      const cached = state.entry
      if (cached !== undefined
        && cached.sourceToken === github.token
        && cached.sourceRevision === source.revision
        && !shouldExchange(cached.api, now(), marginMs)) {
        return cached.api
      }
      // Coalesce: an exchange already flying for THIS credential value serves
      // this caller too, and the caller still leaves on its own signal.
      if (state.inflight !== undefined && state.inflightToken === github.token) {
        return await raceAbort(state.inflight, operation.signal)
      }
      state.ticket++
      const id = state.ticket
      const pending = runExchange(id, { state, options, context, provider, github, source })
      state.inflight = pending
      state.inflightToken = github.token
      return await raceAbort(pending, operation.signal)


    },
    invalidate(): void {
      // Only the entry goes. An in-flight exchange is left alone: it was started
      // by callers that are still waiting on it, and the token it produces is
      // newer than the one being rejected here.
      state.entry = undefined
    },
  }
}

/**
 * The shared exchange's own cancellation source: one controller, driven by one
 * deadline, and reachable by no caller.
 *
 * The deadline is what makes the controller more than ceremony. `copilotFetch`
 * bounds its own dispatch, but the bounded body read afterwards races only the
 * signal it was given — so without a deadline on this signal a stalled read would
 * hold the in-flight slot open indefinitely and every coalesced caller with it.
 * @param options - read for `requestTimeoutMs`.
 * @returns a signal that aborts on the exchange deadline and on nothing else.
 * @throws RangeError when `requestTimeoutMs` cannot serve as a bound.
 */
export function sharedExchangeSignal(options: CopilotTokenCacheOptions): AbortSignal {
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(positiveSafeInteger(
    options.requestTimeoutMs ?? COPILOT_DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  ))
  deadline.addEventListener('abort', () => { controller.abort(deadline.reason) }, { once: true })
  return controller.signal
}

interface CacheState {
  entry: CopilotTokenCacheEntry | undefined
  inflight: Promise<CopilotApiToken> | undefined
  inflightToken: string | undefined
  ticket: number
}
interface ExchangeContext {
  state: CacheState; options: CopilotTokenCacheOptions; context: ModelInvocationContext | undefined;
  provider: string; github: CopilotGitHubToken; source: CopilotCredentialSnapshot;
}

/**
 * Dispatch the one shared exchange and record its result.
 * @param slot - this exchange's ticket, so a later exchange's teardown does
 *   not clear a newer in-flight one.
 * @returns the exchanged token.
 */
async function runExchange(slot: number, ctx: ExchangeContext): Promise<CopilotApiToken> {
  const { state, options, context, provider, github, source } = ctx
  // The cache is the only place BOTH tokens are known at once, so it is the
  // only place that can tell the exchange about the second one. Without
  // this, a body echoing the API token currently held would reach `cause`
  // intact: the exchange redacts the credential it sends, and that is a
  // different string (Requirement 13.7).
  const held = state.entry?.api.token
  try {
    const api = await observeCredentialOperation(
      context,
      provider,
      'refresh',
      () => exchangeCopilotToken(github, {
        ...options,
        ...held === undefined
          ? {}
          : { additionalSecrets: [...options.additionalSecrets ?? [], held] },
        signal: sharedExchangeSignal(options),
      }),
    )
    state.entry = Object.freeze({
      api,
      sourceToken: github.token,
      sourceRevision: source.revision,
    })
    return api
  } finally {
    if (state.ticket === slot) {
      state.inflight = undefined
      state.inflightToken = undefined
    }
  }
}
