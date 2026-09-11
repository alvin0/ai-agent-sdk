/**
 * The credential guard and the raw-surface helpers shared by the two Copilot live
 * integration specs.
 *
 * ## Why a guard, and why it reads the credential STORE
 *
 * Requirement 16.5 is the whole reason this module exists: with no credential the
 * Copilot integration specs have to SKIP THEMSELVES rather than fail, which is the
 * precondition for public CI staying green without holding a secret. The guard
 * therefore reads the Node default `Copilot_Credential_Store` —
 * `.providers/.copilot/auth.json`, or whatever `AI_AGENT_SDK_COPILOT_AUTH` points
 * at — and nothing else. It deliberately does NOT read `.env` or any ad-hoc
 * variable: the store is the one place `Copilot_Login_Cli` writes, so a guard that
 * consulted a second source could report "signed in" for a credential the adapter
 * itself would never find.
 *
 * Every failure mode of that read — no file, unreadable file, invalid JSON, a file
 * with no usable `github.token` — collapses into the same answer, `undefined`,
 * because to a suite deciding whether to run they are one situation: there is no
 * credential to run with.
 *
 * ## Why the helpers below speak raw HTTP
 *
 * Three of the live scenarios check facts about the ENDPOINT rather than about the
 * SDK: which `capabilities.type` values `GET /models` actually returns, that the
 * token-exchange body still carries a readable `expires_at`, and what
 * `POST /embeddings` answers. A helper that went through the adapter would report
 * the adapter's interpretation of those facts, which is exactly the layer under
 * test elsewhere. The stream scenarios, in contrast, DO go through the adapter,
 * because there the claim being checked is that the router's decision is dispatchable.
 *
 * @module tests/helpers/copilot-live
 */

import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { fileCopilotCredentialStore } from '../../packages/auth-node/src/copilot-store.ts'
import {
  COPILOT_BASE_URL,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
} from '../../packages/provider-copilot/src/common/identity.ts'
import {
  exchangeCopilotToken,
  type CopilotApiToken,
} from '../../packages/provider-copilot/src/exchange.ts'
import type { CopilotGitHubToken } from '../../packages/provider-copilot/src/common/store-types.ts'

/** Silent logger: the store's read is instrumented, and a live spec has no sink for it. */
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

/** Bound on the credential read, so a hung filesystem cannot stall collection. */
const CREDENTIAL_READ_TIMEOUT_MS = 10_000

/**
 * Read the long-lived `GitHub_User_Token` from the Node default credential store.
 *
 * @returns the token, or `undefined` when there is no usable credential — which is
 *   the signal the specs skip on (Requirement 16.5).
 */
export async function readDefaultCopilotCredential(): Promise<CopilotGitHubToken | undefined> {
  try {
    const store = fileCopilotCredentialStore(undefined, { cwd: process.cwd(), env: process.env })
    const record = await store.read({
      signal: AbortSignal.timeout(CREDENTIAL_READ_TIMEOUT_MS),
      logger: NULL_LOGGER,
    })
    const github = record?.value.github
    if (github === undefined || github === null) return undefined
    return typeof github.token === 'string' && github.token.length > 0 ? github : undefined
  } catch {
    // Unreadable, malformed, or gone: to a suite deciding whether to run, all of
    // these mean the same thing.
    return undefined
  }
}

/**
 * The credential this file's specs run with, resolved once at import time.
 *
 * Exported as a value rather than a function so each spec's `describe.skipIf` can
 * read it synchronously, which is what keeps the skip a SKIP instead of a failing
 * `beforeAll`.
 */
export const copilotCredential = await readDefaultCopilotCredential()

/** Whether a live Copilot run is possible at all. */
export const copilotLive = copilotCredential !== undefined

/**
 * Perform one real `Copilot_Token_Exchange`.
 *
 * @param signal - the caller's deadline.
 * @returns the short-lived API token.
 */
export async function liveCopilotApiToken(signal?: AbortSignal): Promise<CopilotApiToken> {
  if (copilotCredential === undefined) throw new Error('no Copilot credential; the suite should have skipped')
  return await exchangeCopilotToken(copilotCredential, signal === undefined ? {} : { signal })
}

/**
 * Headers for a raw request to the Copilot API base.
 *
 * Both editor headers are mandatory — without either one the surface answers HTTP
 * 400 — and they are read from the package's own constants so a live spec cannot
 * pass with an identity the adapter does not send.
 * @param apiToken - a live `Copilot_Api_Token`.
 * @returns the header map.
 */
export function copilotLiveHeaders(apiToken: CopilotApiToken): Record<string, string> {
  return {
    authorization: `Bearer ${apiToken.token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'editor-version': COPILOT_EDITOR_VERSION,
    'editor-plugin-version': COPILOT_EDITOR_PLUGIN_VERSION,
  }
}

/**
 * Fetch and parse the raw `GET /models` body.
 *
 * Returns the body UNINTERPRETED: the point of the catalog scenario is to hand the
 * endpoint's own bytes to `partitionCopilotCatalog`, so the check is against
 * reality rather than against a second copy of the classification rules.
 * @param apiToken - a live `Copilot_Api_Token`.
 * @param signal - the caller's deadline.
 * @returns the parsed root object of the catalog response.
 */
export async function fetchCopilotCatalogBody(
  apiToken: CopilotApiToken,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/models', COPILOT_BASE_URL), {
    method: 'GET',
    headers: copilotLiveHeaders(apiToken),
    redirect: 'error',
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`GET /models answered HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('GET /models did not answer a JSON object')
  }
  return body as Record<string, unknown>
}

export { COPILOT_BASE_URL }
