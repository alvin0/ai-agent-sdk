import { CopilotDeviceLoginError, credentialFailure, type CopilotDeviceLoginReason } from './errors.ts'
import { COPILOT_DEVICE_CODE_MAX_WAIT_MS, COPILOT_LOGIN_COMMAND } from './oauth-types.ts'

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw deviceAborted()
}

export function deviceAborted(): CopilotDeviceLoginError {
  return deviceFailure('the device login was cancelled', 'aborted')
}

export function deviceTimeout(startedAt: number, now: number): CopilotDeviceLoginError {
  return deviceFailure(
    `the device login was not approved within ${Math.round((now - startedAt) / 1_000)}s`
    + ` (bound: ${COPILOT_DEVICE_CODE_MAX_WAIT_MS / 60_000} minutes);`
    + ` run \`${COPILOT_LOGIN_COMMAND}\` again`,
    'timeout',
  )
}

export function deviceFailure(
  message: string,
  reason: CopilotDeviceLoginReason,
  cause?: unknown,
): CopilotDeviceLoginError {
  return new CopilotDeviceLoginError(credentialFailure(message, cause), reason)
}
