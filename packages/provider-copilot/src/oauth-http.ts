import { copilotFetch, readCopilotResponseText, type CopilotRequest } from './common/http.ts'
import { CopilotDeviceLoginError } from './errors.ts'
import type { CopilotOAuthOptions, DeviceJson } from './oauth-types.ts'
import { deviceFailure, throwIfAborted } from './oauth-errors.ts'
import { requireDeviceString } from './oauth-values.ts'

/**
 * Dispatch one OAuth leg and read its body within the configured bounds.
 *
 * A body that is not a JSON object yields an EMPTY object plus `parseError`
 * rather than throwing: the status still has to be classified, and on the token
 * leg an unreadable body is one of the shapes a misconfigured `Accept` header
 * produces. Callers therefore always get to the body-first branch, and reach a
 * hard failure only after it finds no `error`.
 */
export async function deviceJson(
  request: CopilotRequest,
  what: string,
  options: CopilotOAuthOptions,
): Promise<DeviceJson> {
  let response: Response
  try {
    response = await copilotFetch(request, options)
  } catch (error: unknown) {
    throwIfAborted(options.signal)
    throw error instanceof CopilotDeviceLoginError
      ? error
      : deviceFailure(`${what} could not be reached`, 'failed', error)
  }
  let raw: string
  try {
    raw = await readCopilotResponseText(response, options)
  } catch (error: unknown) {
    throwIfAborted(options.signal)
    throw deviceFailure(`${what} returned a response beyond the configured limits`, 'failed', error)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError(`${what} returned JSON that is not an object`)
    }
    return {
      ok: response.ok,
      status: response.status,
      json: parsed as Record<string, unknown>,
      parseError: undefined,
    }
  } catch (error: unknown) {
    return { ok: response.ok, status: response.status, json: {}, parseError: error }
  }
}

/**
 * Read the verification URL the user is told to open.
 *
 * Only the SCHEME is constrained, not the origin. This SDK never fetches this
 * URL — it prints it — and GitHub Enterprise deployments legitimately answer with
 * a host other than the issuer, so an origin pin here would reject working
 * installations to guard a request that is never made. The scheme check remains
 * because a `javascript:` or `data:` URL handed to a browser opener is a real
 * problem, and {@link COPILOT_DEVICE_LOGIN_WARNING} covers the rest.
 */
export function verificationUrlOf(
  body: Record<string, unknown>,
  options: CopilotOAuthOptions,
): string {
  const raw = requireDeviceString(body, 'verification_uri')
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw deviceFailure('the device-code endpoint returned an unusable verification URL', 'failed', error)
  }
  if (url.protocol !== 'https:'
    && !(options.allowInsecureIssuer === true && url.protocol === 'http:')) {
    throw deviceFailure('the device-code verification URL must use https', 'failed')
  }
  return url.href
}
