/**
 * The OAuth device flow behind the Copilot credential file.
 *
 * Device code rather than a browser redirect for the same reason the Codex
 * provider chose it: this SDK has no business binding a localhost port, and the
 * flow has to work over SSH, in containers, and in CI with no callback server.
 *
 * ## Client identity
 *
 * `COPILOT_OAUTH_CLIENT_ID` is one of three `Client_Identity_Constants` in this
 * package — the other two are `COPILOT_EDITOR_VERSION` and
 * `COPILOT_EDITOR_PLUGIN_VERSION` in `./adapter.ts`. All three default to values
 * that make this SDK identify itself AS AN EDITOR CLIENT when it signs in and
 * when it calls the Copilot surface. That is not a side effect; it is what makes
 * the surface answer at all, because `copilot_internal/v2/token` only accepts a
 * token minted by an OAuth App on GitHub's allowlist and a personal access token
 * cannot stand in for one.
 *
 * Because presenting as another client is a decision the caller should be able
 * to see and change, all three are EXPORTED, OVERRIDABLE constants rather than
 * hidden values buried in a request builder — the same reason
 * `CODEX_CLIENT_VERSION` is an exported constant in `provider-codex`. Each also
 * has a matching named option (`clientId` here, `editorHeaders` on the adapter),
 * so overriding one needs no fork. See the README and the "Client identity"
 * section of the docs for the full tradeoff, and prefer a provider's official
 * first-party surface for production.
 *
 * ## The two legs, and what is load-bearing about each
 *
 * ```text
 * POST {issuer}/login/device/code        → { device_code, user_code,
 *   Accept: application/json               verification_uri, expires_in, interval }
 *
 * POST {issuer}/login/oauth/access_token → { access_token, token_type, scope }
 *   Accept: application/json               or HTTP 200 { error, interval? }
 * ```
 *
 * `Accept: application/json` is mandatory on BOTH legs, and the error channel on
 * the second leg is an HTTP 200 carrying `error` — see
 * {@link pollForCopilotToken} for why each of those changes the shape of the
 * code rather than just its headers.
 *
 * @module ai-agent-sdk/providers/copilot/oauth
 */

import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { copilotUrl, issuerOf } from './common/http.ts'
import { captureCopilotStore } from './common/store-capture.ts'
import type { CopilotAuthFile, CopilotAuthStore, CopilotCredentialStore } from './common/store-types.ts'
import {
  DEFAULT_COPILOT_OAUTH_ISSUER, COPILOT_OAUTH_CLIENT_ID, COPILOT_OAUTH_SCOPE,
  COPILOT_DEVICE_CODE_MAX_WAIT_MS, COPILOT_DEFAULT_POLL_INTERVAL_SECONDS, DEVICE_CODE_PATH,
  NEVER_ABORTED_SIGNAL, NULL_LOGGER,
} from './oauth-types.ts'
import type {
  CopilotOAuthOptions, CopilotDeviceCode, CopilotLoginProgress, CopilotLoginResult, AnyCopilotStore,
} from './oauth-types.ts'
export {
  DEFAULT_COPILOT_OAUTH_ISSUER, COPILOT_OAUTH_CLIENT_ID, COPILOT_OAUTH_SCOPE,
  COPILOT_DEVICE_CODE_MAX_WAIT_MS, COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
  COPILOT_SLOW_DOWN_INCREMENT_SECONDS, COPILOT_DEVICE_LOGIN_WARNING, DEFAULT_COPILOT_TIMER,
} from './oauth-types.ts'
export type {
  CopilotTimer, CopilotOAuthOptions, CopilotDeviceCode, CopilotLoginProgress, CopilotLoginResult,
} from './oauth-types.ts'
import { deviceJson, verificationUrlOf } from './oauth-http.ts'
import { requireDeviceString, positiveSecondsOf } from './oauth-values.ts'
import { timerOf, notify, readStore, commitStore } from './oauth-support.ts'
import { deviceFailure } from './oauth-errors.ts'
import { pollForCopilotToken } from './oauth-poll.ts'

/**
 * Start a device authorization.
 *
 * `Accept: application/json` is set here as well as on the token leg. It is
 * load-bearing on the token leg (see {@link pollForCopilotToken}) and harmless
 * here, and setting it on both keeps the pair from drifting into "one of the two
 * legs parses JSON".
 * @param options - issuer, client id, scope, cancellation and read bounds.
 * @returns the code, the URL and the timings to show the user.
 * @throws CopilotDeviceLoginError with `reason: 'aborted'` when the caller's
 *   signal aborts, or `reason: 'failed'` when the endpoint answers with anything
 *   other than a usable device authorization.
 */
export async function requestCopilotDeviceCode(
  options: CopilotOAuthOptions = {},
): Promise<CopilotDeviceCode> {
  const pinned = issuerOf('oauthIssuer', options.oauthIssuer, DEFAULT_COPILOT_OAUTH_ISSUER, options)
  const body = await deviceJson(
    {
      pinned,
      url: copilotUrl(pinned, DEVICE_CODE_PATH),
      operation: 'device code',
      init: {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
          scope: options.scope ?? COPILOT_OAUTH_SCOPE,
        }),
      },
    },
    'the device-code endpoint',
    options,
  )
  if (!body.ok) {
    throw deviceFailure(
      `the device-code endpoint failed (HTTP ${body.status})`,
      'failed',
      body.parseError,
    )
  }
  return Object.freeze({
    verificationUrl: verificationUrlOf(body.json, options),
    userCode: requireDeviceString(body.json, 'user_code'),
    deviceCode: requireDeviceString(body.json, 'device_code'),
    intervalSeconds: positiveSecondsOf(body.json.interval, COPILOT_DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds: positiveSecondsOf(
      body.json.expires_in,
      COPILOT_DEVICE_CODE_MAX_WAIT_MS / 1_000,
    ),
  })
}

export function runCopilotDeviceLogin(
  store: CopilotCredentialStore,
  options?: CopilotOAuthOptions,
  progress?: CopilotLoginProgress,
): Promise<CopilotLoginResult>
export function runCopilotDeviceLogin(
  store: CopilotAuthStore,
  options?: CopilotOAuthOptions,
  progress?: CopilotLoginProgress,
): Promise<CopilotLoginResult>
export async function runCopilotDeviceLogin(
  store: AnyCopilotStore,
  options: CopilotOAuthOptions = {},
  progress: CopilotLoginProgress = {},
): Promise<CopilotLoginResult> {
  const captured = captureCopilotStore(store)
  const operation: CredentialOperationOptions = {
    signal: options.signal ?? NEVER_ABORTED_SIGNAL,
    logger: NULL_LOGGER,
  }
  const initial = await readStore(captured, operation)
  const code = await requestCopilotDeviceCode(options)
  notify(() => progress.onPrompt?.(code))
  const token = await pollForCopilotToken(code, options, progress)
  const file: CopilotAuthFile = {
    version: 1,
    github: {
      token: token.accessToken,
      ...token.tokenType === undefined ? {} : { tokenType: token.tokenType },
      ...token.scope === undefined ? {} : { scope: token.scope },
    },
    ...token.account === undefined ? {} : { account: token.account },
    clientId: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
    obtainedAt: new Date(timerOf(options).now()).toISOString(),
  }
  await commitStore(captured, file, initial.revision, operation)
  return Object.freeze({
    location: captured.label,
    login: token.account?.login,
    accountId: token.account?.id,
    scope: token.scope,
  })
}
