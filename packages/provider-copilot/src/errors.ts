/**
 * The Copilot error taxonomy: the codes this provider owns, the two error
 * classes that carry a machine-readable classification beside them, and the one
 * door through which every credential-path error is built.
 *
 * ## What is deliberately NOT here
 *
 * Three situations get an EXISTING code rather than a Copilot one, because a
 * second code for the same situation forces every consumer to write a second
 * branch for it:
 *
 * - **No credential at all** — `MISSING_CREDENTIAL_CODE` from `packages/core`,
 *   with a message naming the login command (Requirement 13.4).
 * - **Abort** — the SDK's existing abort code, {@link MODEL_ERROR_CODES.ABORTED}
 *   (Requirement 4.6). `CopilotDeviceLoginError` with `reason: 'aborted'` maps to
 *   it rather than minting a Copilot abort code.
 * - **HTTP failures of the generation/embedding endpoints** — `MODEL_ERROR_CODES`
 *   plus `HTTP_PROVIDER_ERROR_CODES`. In particular there is no
 *   `COPILOT_RATE_LIMIT`: a 429 from Copilot is `RATE_LIMIT`, the same as from
 *   every other provider (Requirements 13.5, 15.5).
 *
 * @module ai-agent-sdk/providers/copilot/errors
 */

import {
  AgentSdkError,
  MODEL_ERROR_CODES,
  ModelError,
  safeErrorRecord,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'
import { COPILOT_ERROR_CODES, type CopilotErrorCode } from './common/error-codes.ts'

/**
 * The codes this module owns, defined in `./common/error-codes.ts` and re-exported
 * here.
 *
 * The definition sits one layer down only so `common/http.ts` can throw
 * `ENDPOINT_ORIGIN_INVALID` and `REDIRECT_REJECTED` without `common/` importing a
 * root module — `common/` is a leaf, and the root already imports it. This module
 * remains the door consumers read.
 */
export { COPILOT_ERROR_CODES, type CopilotErrorCode } from './common/error-codes.ts'

/**
 * Mirrors `safeProviderFailure` from `provider-http`: a {@link ModelError} keeps
 * its stable code and status and LOSES its message, because a provider message
 * is the one field that can have echoed a request header back at us.
 * @param failure - the serializable twin carried by a {@link ModelError}.
 * @returns a frozen record with no provider-authored text in it.
 */
function safeModelFailure(failure: ModelError['failure']): SafeErrorRecord {
  return Object.freeze({
    type: 'ModelError',
    message: 'provider attempt failed; inspect the stable code and request ID',
    code: failure.code,
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

/** A sanitized cause plus the message it is allowed to travel with. */
export interface CopilotCredentialFailure {
  /** SDK-authored text. Never carries a token value, because nothing interpolates one in. */
  readonly message: string
  /** The cause, reduced to serializable facts; `undefined` when there was none. */
  readonly cause: SafeErrorRecord | undefined
}

/**
 * Build the inputs for an error on the Copilot credential path.
 *
 * This is the ONLY door: {@link CopilotTokenExchangeError} and
 * {@link CopilotDeviceLoginError} take a {@link CopilotCredentialFailure} rather
 * than a raw `cause`, so there is no code path that can attach an unfiltered
 * value to a credential-path error. `message` is SDK-authored text; a
 * `GitHub_User_Token` or a `Copilot_Api_Token` is never interpolated into it, and
 * response bodies reach `cause` only after the bounded read has replaced every
 * occurrence of the tokens held in memory with `[REDACTED]` (Requirement 13.7).
 * @param message - SDK-authored, actionable text. No token values.
 * @param cause - the caught value, if any; filtered before it is retained.
 * @returns the sanitized pair an error class accepts.
 */
export function credentialFailure(message: string, cause?: unknown): CopilotCredentialFailure {
  return Object.freeze({
    message,
    cause: cause === undefined
      ? undefined
      // A ModelError already carries the serializable twin, so route it through
      // the same reduction the provider attempt ledger uses. Anything else keeps
      // only bounded facts, and never a stack.
      : cause instanceof ModelError ? safeModelFailure(cause.failure) : safeErrorRecord(cause),
  })
}

/** Whether a token-exchange failure can ever succeed on a retry. */
export type CopilotTokenExchangeFailureKind = 'permanent' | 'transient'

/**
 * A `Copilot_Token_Exchange` that did not produce a token.
 *
 * `kind` exists because `code` alone does not answer the only question a caller
 * has to answer next: `TOKEN_EXCHANGE_FAILED` covers both a 5xx worth waiting out
 * and a 4xx that will fail identically forever.
 */
export class CopilotTokenExchangeError extends AgentSdkError {
  /** Retry classification for this failure. */
  readonly kind: CopilotTokenExchangeFailureKind

  /**
   * @param failure - message and filtered cause from {@link credentialFailure}.
   * @param code - the Copilot code for this row of the classification table.
   * @param kind - whether a retry could ever succeed.
   */
  constructor(
    failure: CopilotCredentialFailure,
    code: CopilotErrorCode,
    kind: CopilotTokenExchangeFailureKind,
  ) {
    super(failure.message, code, failure.cause === undefined ? undefined : { cause: failure.cause })
    this.kind = kind
  }
}

/** Why a device login ended without a token. */
export type CopilotDeviceLoginReason = 'denied' | 'expired' | 'timeout' | 'aborted' | 'failed'

/**
 * Codes for the four device-flow outcomes this provider owns.
 *
 * `denied` and `expired` are separate on purpose: "you just declined this" and
 * "the code ran out" lead to different next steps. `aborted` is absent because it
 * maps to the SDK's existing abort code instead.
 */
const DEVICE_LOGIN_CODES = Object.freeze({
  denied: COPILOT_ERROR_CODES.DEVICE_LOGIN_DENIED,
  expired: COPILOT_ERROR_CODES.DEVICE_LOGIN_EXPIRED,
  timeout: COPILOT_ERROR_CODES.DEVICE_LOGIN_TIMEOUT,
  failed: COPILOT_ERROR_CODES.DEVICE_LOGIN_FAILED,
} as const)

/**
 * A device login that ended without a `GitHub_User_Token`.
 *
 * The `code` is derived from `reason` rather than passed in, so the two can never
 * disagree — a caller reading `code` and a caller reading `reason` always see the
 * same outcome.
 */
export class CopilotDeviceLoginError extends AgentSdkError {
  /** The distinguishable reason the flow ended. */
  readonly reason: CopilotDeviceLoginReason

  /**
   * @param failure - message and filtered cause from {@link credentialFailure}.
   * @param reason - the outcome; decides the `code`, with `aborted` mapping to
   *   {@link MODEL_ERROR_CODES.ABORTED} rather than a Copilot-specific code.
   */
  constructor(failure: CopilotCredentialFailure, reason: CopilotDeviceLoginReason) {
    super(
      failure.message,
      reason === 'aborted' ? MODEL_ERROR_CODES.ABORTED : DEVICE_LOGIN_CODES[reason],
      failure.cause === undefined ? undefined : { cause: failure.cause },
    )
    this.reason = reason
  }
}
