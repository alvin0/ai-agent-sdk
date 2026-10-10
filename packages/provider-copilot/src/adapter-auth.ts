import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@alvin0/ai-agent-sdk-core'
import { type CredentialOperationOptions, type SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { requireGitHubToken, type CopilotCredentialSnapshot } from './auth.ts'
import { type CapturedCopilotStore } from './common/store-capture.ts'
import type { CopilotAuthFile } from './common/store-types.ts'
const REDACTED = '[REDACTED]'

/** Never-aborting logger sink for a resolve that arrives without a context. */
export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

/**
 * Read the credential store once, through whichever variant was captured.
 *
 * The read/write variant has no revisions, so its snapshot revision is `null` —
 * which the token cache compares just as strictly as a real revision, it simply
 * never changes on its own.
 * @param captured - the captured store.
 * @param operation - the calling operation, whose signal bounds the read.
 * @returns the file, its revision and the store label, as one snapshot.
 * @throws AgentSdkError with the SDK's missing-credential code when the store is
 *   empty (Requirement 13.4).
 */
export async function readCopilotSnapshot(
  captured: CapturedCopilotStore,
  operation: CredentialOperationOptions,
): Promise<CopilotCredentialSnapshot> {
  const record = captured.kind === 'versioned'
    ? await captured.store.read(operation)
    : { value: await captured.store.read(), revision: null }
  return Object.freeze({
    file: requireCopilotFile(record?.value, captured.label),
    revision: record?.revision ?? null,
    label: captured.label,
  })
}

/**
 * Demand a credential file, reusing the one message that says how to get one.
 *
 * `requireGitHubToken` owns the message and the code for all three shapes of "no
 * credential", so it is asked first. The throw after it is UNREACHABLE — an
 * absent file already failed there — and exists only so the type narrows without
 * a non-null assertion.
 * @param file - the file the store returned, or `undefined` for an empty store.
 * @param label - the store location named in the diagnostic.
 * @returns the file.
 */
export function requireCopilotFile(file: CopilotAuthFile | undefined, label: string): CopilotAuthFile {
  requireGitHubToken(file, label)
  if (file === undefined) {
    throw new AgentSdkError(
      `no GitHub Copilot credentials at ${label}`,
      MISSING_CREDENTIAL_CODE,
    )
  }
  return file
}

/**
 * The two token values currently held in memory, and the redaction that uses them.
 *
 * Two slots rather than a growing set: there is exactly one long-lived token and
 * one API token in play at a time, and a set that only ever grows would be a
 * credential leak of its own making.
 */
export interface CopilotSecrets {
  /** Record the current value of one of the two tokens. */
  remember(kind: 'github' | 'api', value: string): void
  /** Replace every occurrence of either token with {@link REDACTED}. */
  redact(text: string): string
}

/** Build the two-slot secret registry. */
export function createCopilotSecrets(): CopilotSecrets {
  let github = ''
  let api = ''
  return {
    remember(kind, value): void {
      if (value.length === 0) return
      if (kind === 'github') github = value
      else api = value
    },
    redact(text): string {
      let result = text
      for (const secret of [github, api]) {
        if (secret.length === 0) continue
        result = result.split(secret).join(REDACTED)
      }
      return result
    },
  }
}

/** A client-side correlation id; carries nothing about the account or the prompt. */
export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sdk-${Date.now().toString(36)}`
}
