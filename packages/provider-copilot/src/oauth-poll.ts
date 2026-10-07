import { copilotUrl, issuerOf } from './common/http.ts'
import {
  DEFAULT_COPILOT_OAUTH_ISSUER, COPILOT_OAUTH_CLIENT_ID, COPILOT_DEVICE_CODE_MAX_WAIT_MS, DEVICE_TOKEN_PATH,
  DEVICE_GRANT_TYPE, COPILOT_LOGIN_COMMAND,
} from './oauth-types.ts'
import type {
  CopilotOAuthOptions, CopilotDeviceCode, CopilotLoginProgress, CopilotAccessToken, DeviceJson,
} from './oauth-types.ts'
import { deviceJson } from './oauth-http.ts'
import { timerOf, notify, nextIntervalSeconds, sleep } from './oauth-support.ts'
import { throwIfAborted, deviceTimeout, deviceFailure } from './oauth-errors.ts'
import { requireDeviceString, optionalString, accountIdentityOf } from './oauth-values.ts'

/**
 * Poll the token leg until the user approves, the server refuses, or a bound
 * passes.
 *
 * Two things make this loop different from the Codex one, and both are easy to
 * get wrong:
 *
 * - **`Accept: application/json` is mandatory.** Without it GitHub's token
 *   endpoint answers FORM-ENCODED, so a JSON parser meets
 *   `error=authorization_pending&interval=10` and throws — which turns the "not
 *   approved yet" branch into a hard-failure branch, and the flow can then never
 *   succeed at all.
 * - **The error channel is HTTP 200 with `error` in the body.** Codex surfaces
 *   "pending" as 403/404; GitHub surfaces it as a 200. So classification reads the
 *   BODY FIRST and the status second. A status-first reader treats every pending
 *   poll as a success and then fails looking for `access_token`.
 * @param code - the pending authorization.
 * @param options - issuer, client id, bounds and the injectable timer.
 * @param progress - poll notifications.
 * @returns the access token and whatever the endpoint disclosed beside it.
 */
export async function pollForCopilotToken(
  code: CopilotDeviceCode,
  options: CopilotOAuthOptions,
  progress: CopilotLoginProgress,
): Promise<CopilotAccessToken> {
  const pinned = issuerOf('oauthIssuer', options.oauthIssuer, DEFAULT_COPILOT_OAUTH_ISSUER, options)
  const url = copilotUrl(pinned, DEVICE_TOKEN_PATH)
  const timer = timerOf(options)
  const startedAt = timer.now()
  // The 15-minute ceiling is absolute; `expires_in` only ever pulls the deadline
  // in. min() is the whole of that rule.
  const deadlineAt = startedAt + Math.min(
    COPILOT_DEVICE_CODE_MAX_WAIT_MS,
    code.expiresInSeconds * 1_000,
  )
  let intervalSeconds = code.intervalSeconds

  while (true) {
    throwIfAborted(options.signal)
    if (timer.now() >= deadlineAt) throw deviceTimeout(startedAt, timer.now())
    notify(() => progress.onPoll?.(timer.now() - startedAt, intervalSeconds))

    const body = await pollToken({ pinned, url, code, options })

    // Body first, status second.
    const error = typeof body.json.error === 'string' ? body.json.error : undefined
    if (error === 'authorization_pending' || error === 'slow_down') {
      intervalSeconds = nextIntervalSeconds(intervalSeconds, body.json.interval, error)
      const remaining = deadlineAt - timer.now()
      if (remaining <= 0) throw deviceTimeout(startedAt, timer.now())
      await sleep(Math.min(intervalSeconds * 1_000, remaining), options.signal, timer)
      continue
    }
    assertTokenResponse(body, error)
    return Object.freeze({
      accessToken: requireDeviceString(body.json, 'access_token'),
      tokenType: optionalString(body.json.token_type),
      scope: optionalString(body.json.scope),
      account: accountIdentityOf(body.json),
    })
  }
}

function pollToken(input: {
  pinned: ReturnType<typeof issuerOf>; url: string; code: CopilotDeviceCode; options: CopilotOAuthOptions;
}) {
  const { pinned, url, code, options } = input
  return deviceJson(
      {
        pinned,
        url,
        operation: 'device token',
        init: {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
            device_code: code.deviceCode,
            grant_type: DEVICE_GRANT_TYPE,
          }),
        },
      },
      'the device-token endpoint',
      options,
    )

}

function assertTokenResponse(body: DeviceJson, error: string | undefined): void {
  if (error === 'access_denied') {
    throw deviceFailure(
      'the device login was denied on GitHub;'
      + ` run \`${COPILOT_LOGIN_COMMAND}\` again if you did mean to approve it`,
      'denied',
    )
  }
  if (error === 'expired_token') {
    throw deviceFailure(
      `the device code expired before it was approved; run \`${COPILOT_LOGIN_COMMAND}\``
      + ' again to request a new code',
      'expired',
    )
  }
  if (error !== undefined) {
    throw deviceFailure(
      `the device-token endpoint refused the request (${error}, HTTP ${body.status})`,
      'failed',
    )
  }
  if (!body.ok) {
    throw deviceFailure(
      `the device-token endpoint failed (HTTP ${body.status})`,
      'failed',
      body.parseError,
    )
  }
}
