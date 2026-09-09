/**
 * Codex sign-in for the web UI.
 *
 * The device-code flow is long-running and interactive, so it is started by one
 * request (which returns the URL and the one-time code) and polled by another.
 * Tokens are written to the project-local store — never to the Codex CLI's own
 * `~/.codex/auth.json`, because a shared refresh token would eventually log the
 * real CLI out.
 */

import {
  fileCodexAuthStore, readJwtClaims, requireTokens, resolveCodexAuthPath, runDeviceCodeLogin,
} from '@alvin0/ai-agent-sdk-auth-node/codex'
import type { CodexDeviceCode, CodexLoginResult } from '@alvin0/ai-agent-sdk-auth-node/codex'

export interface CodexAccount {
  readonly signedIn: boolean
  readonly email?: string
  readonly planType?: string
  readonly location: string
}

export type CodexLoginState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly verificationUrl: string; readonly userCode: string }
  | { readonly status: 'signed-in'; readonly account: CodexAccount }
  | { readonly status: 'error'; readonly message: string }

interface LoginAttempt {
  state: CodexLoginState
  controller: AbortController
}

const ATTEMPT_KEY = Symbol.for('@chat-agents/backend.codex-login')

function attemptSlot(): { current: LoginAttempt | undefined } {
  const holder = globalThis as unknown as Record<symbol, { current: LoginAttempt | undefined } | undefined>
  const existing = holder[ATTEMPT_KEY]
  if (existing !== undefined) return existing
  const created = { current: undefined }
  holder[ATTEMPT_KEY] = created
  return created
}

/**
 * Read the stored Codex credential.
 * @returns The signed-in account, or a `signedIn: false` record.
 */
export async function codexAccount(): Promise<CodexAccount> {
  const location = resolveCodexAuthPath()
  try {
    const store = fileCodexAuthStore()
    const file = await store.read()
    const tokens = requireTokens(file, store.location)
    const claims = readJwtClaims(tokens.id_token)
    return {
      signedIn: true,
      ...claims?.email === undefined ? {} : { email: claims.email },
      ...claims?.planType === undefined ? {} : { planType: claims.planType },
      location,
    }
  } catch {
    return { signedIn: false, location }
  }
}

/**
 * Whether a Codex credential exists.
 * @returns True when the adapter can be registered.
 */
export async function codexSignedIn(): Promise<boolean> {
  return (await codexAccount()).signedIn
}

/**
 * Start a device-code login, or return the attempt already in flight.
 *
 * The returned state carries the verification URL and one-time code as soon as
 * the issuer hands them over; the caller then polls {@link codexLoginState}.
 * @returns The current login state.
 */
export async function startCodexLogin(): Promise<CodexLoginState> {
  const slot = attemptSlot()
  if (slot.current?.state.status === 'pending') return slot.current.state

  const controller = new AbortController()
  const attempt: LoginAttempt = { state: { status: 'idle' }, controller }
  slot.current = attempt

  let announce: (state: CodexLoginState) => void = () => undefined
  const prompted = new Promise<CodexLoginState>((resolve) => { announce = resolve })
  const store = fileCodexAuthStore()

  void runDeviceCodeLogin(store, { signal: controller.signal }, {
    onPrompt: (code: CodexDeviceCode) => {
      attempt.state = {
        status: 'pending',
        verificationUrl: code.verificationUrl,
        userCode: code.userCode,
      }
      announce(attempt.state)
    },
  }).then(
    async (result: CodexLoginResult) => {
      attempt.state = {
        status: 'signed-in',
        account: {
          signedIn: true,
          ...result.email === undefined ? {} : { email: result.email },
          ...result.planType === undefined ? {} : { planType: result.planType },
          location: result.location,
        },
      }
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      attempt.state = { status: 'error', message }
      announce(attempt.state)
    },
  )

  // The prompt normally arrives in well under a second; a slow issuer surfaces
  // as `idle`, which the client keeps polling.
  const raced = await Promise.race([
    prompted,
    new Promise<CodexLoginState>((resolve) => {
      setTimeout(() => { resolve(attempt.state) }, 15_000)
    }),
  ])
  return raced
}

/**
 * Poll the in-flight login.
 * @returns The attempt's state, or the stored account when no attempt is running.
 */
export async function codexLoginState(): Promise<CodexLoginState> {
  const slot = attemptSlot()
  const current = slot.current
  if (current === undefined || current.state.status === 'idle') {
    const account = await codexAccount()
    return account.signedIn ? { status: 'signed-in', account } : { status: 'idle' }
  }
  return current.state
}

/**
 * Cancel an in-flight login.
 * @returns Whether an attempt was cancelled.
 */
export function cancelCodexLogin(): boolean {
  const slot = attemptSlot()
  const current = slot.current
  if (current === undefined || current.state.status !== 'pending') return false
  current.controller.abort(new Error('login cancelled by the user'))
  current.state = { status: 'idle' }
  slot.current = undefined
  return true
}
