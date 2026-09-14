/** Fail-closed error surface. Silent unconfined passthrough is never legal. */

/** Thrown when no backend on this host can enforce a confining policy. */
export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE' as const
  /** Runner ids that were considered for this platform, in chain order. */
  readonly attempted: readonly string[]

  constructor(readonly platform: string, attempted: readonly string[] = [], detail?: string) {
    const options = attempted.length === 0 ? 'no runner is available' : `tried ${attempted.join(', ')}`
    super(`No sandbox backend can confine this execution on ${platform}: ${options}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'SandboxUnavailableError'
    this.attempted = Object.freeze([...attempted])
  }
}

/** Thrown by the in-process fence when a mutation leaves the permitted roots. */
export class SandboxDeniedError extends Error {
  readonly code = 'SANDBOX_DENIED' as const

  constructor(readonly path: string, readonly mode: string, readonly writableRoots: readonly string[]) {
    const permitted = writableRoots.length === 0 ? 'nothing is writable' : `writable roots: ${writableRoots.join(', ')}`
    super(`Sandbox mode '${mode}' denies writing ${path} (${permitted})`)
    this.name = 'SandboxDeniedError'
  }
}

/** Thrown when a policy is structurally unusable before any backend is asked. */
export class SandboxPolicyError extends Error {
  readonly code = 'SANDBOX_POLICY_INVALID' as const

  constructor(message: string) {
    super(message)
    this.name = 'SandboxPolicyError'
  }
}
