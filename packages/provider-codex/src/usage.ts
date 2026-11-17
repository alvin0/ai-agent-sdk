/**
 * Read the account's remaining Codex usage without spending any of it.
 *
 * The ChatGPT backend serves the same usage endpoint the Codex CLI reads for its
 * `/status` view. It reports usage as a percentage of rolling plan windows (five
 * hours and one week on current plans), plus credits and per-model availability.
 *
 * @module ai-agent-sdk/providers/codex/usage
 */

import { AgentSdkError, waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { isFedrampAccount, resolveAccountId, type CodexTokens } from './auth.ts'
import { CODEX_BASE_URL, CODEX_ORIGINATOR } from './adapter-types.ts'
import { positiveSafeInteger, raceAbort, readCatalogJson } from './catalog.ts'
import { rejectCodexRedirect } from './common/no-follow.ts'
import { getCodexTokens } from './oauth.ts'
import { parseCodexUsageBody } from './usage-parse.ts'
import type { CodexUsage, GetCodexUsageOptions } from './usage-types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 256 * 1024
const MAX_CHUNKS = 10_000

/**
 * The usage request failed. Route on `code`:
 * `CODEX_USAGE_UNAUTHORIZED` (HTTP 401/403 — sign in again), `CODEX_USAGE_HTTP`
 * (another error status), `CODEX_USAGE_TIMEOUT`, `CODEX_USAGE_NETWORK`,
 * `CODEX_USAGE_REDIRECT`, `CODEX_USAGE_TOO_LARGE` or `CODEX_USAGE_MALFORMED`.
 */
export class CodexUsageError extends AgentSdkError {
  /** HTTP status, when the endpoint answered. */
  readonly status?: number

  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, code, options)
    if (status !== undefined) this.status = status
  }
}

/** Hosts whose bare origin the Codex CLI maps onto the ChatGPT backend. */
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com'])

/**
 * The usage endpoint for a Codex API base, mapped as the Codex CLI does.
 *
 * A ChatGPT backend base (`…/backend-api/codex`, the default, or a bare
 * `https://chatgpt.com`) maps to `…/backend-api/wham/usage`; any other base maps
 * to `<base>/api/codex/usage`.
 */
export function codexUsageUrl(baseUrl: string = CODEX_BASE_URL): string {
  const url = new URL(baseUrl)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Codex base URL must not contain credentials')
  }
  if (url.protocol !== 'https:') throw new TypeError('Codex base URL must use https')
  const path = url.pathname.replace(/\/+$/, '')
  const backend = /\/backend-api(?=\/|$)/.exec(path)
  if (backend !== null) url.pathname = `${path.slice(0, backend.index)}/backend-api/wham/usage`
  else if (path === '' && CHATGPT_HOSTS.has(url.hostname)) url.pathname = '/backend-api/wham/usage'
  else url.pathname = `${path}/api/codex/usage`
  url.search = ''
  url.hash = ''
  return url.href
}

function usageHeaders(tokens: CodexTokens, originator: string): Record<string, string> {
  const accountId = resolveAccountId(tokens)
  return {
    'authorization': `Bearer ${tokens.access_token}`,
    'originator': originator,
    'accept': 'application/json',
    ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
    ...isFedrampAccount(tokens) ? { 'x-openai-fedramp': 'true' } : {},
  }
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
}

async function failedStatus(response: Response): Promise<CodexUsageError> {
  await cancelBody(response)
  const unauthorized = response.status === 401 || response.status === 403
  return new CodexUsageError(
    unauthorized
      ? `Codex usage request was rejected (HTTP ${response.status}); sign in again`
      : `Codex usage request failed (HTTP ${response.status})`,
    unauthorized ? 'CODEX_USAGE_UNAUTHORIZED' : 'CODEX_USAGE_HTTP',
    response.status,
  )
}

/** Whether `readCatalogJson` itself rejected the body (as opposed to the stream failing). */
function malformedBody(error: unknown): boolean {
  return error instanceof SyntaxError
    || (error instanceof TypeError && error.message.startsWith('Codex usage response'))
}

async function readUsageBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<CodexUsage> {
  let body: Record<string, unknown>
  try {
    body = await readCatalogJson(response, { maxBytes, maxChunks: MAX_CHUNKS, what: 'usage response' }, signal)
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new CodexUsageError(error.message, 'CODEX_USAGE_TOO_LARGE', response.status, { cause: error })
    }
    if (malformedBody(error)) {
      throw new CodexUsageError('Codex usage response was not a JSON object', 'CODEX_USAGE_MALFORMED',
        response.status, { cause: error })
    }
    throw error
  }
  return parseCodexUsageBody(body)
}

interface UsageRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly fetchImpl: typeof globalThis.fetch
  readonly maxBytes: number
}

async function requestUsage(request: UsageRequest, signal: AbortSignal): Promise<CodexUsage> {
  const { url, headers, fetchImpl, maxBytes } = request
  const pending = Promise.resolve(fetchImpl(url, { headers, signal, redirect: 'manual' }))
  // A fetch that ignores the signal may still deliver after cancellation; release that body.
  void pending.then(response => signal.aborted ? cancelBody(response) : undefined, () => undefined)
  const response = await raceAbort(pending, signal)
  try {
    await rejectCodexRedirect(response, url, 'usage', 30_000)
  } catch (error: unknown) {
    throw new CodexUsageError('Codex usage request was redirected; refusing to follow it',
      'CODEX_USAGE_REDIRECT', response.status, { cause: error })
  }
  if (!response.ok) throw await failedStatus(response)
  return readUsageBody(response, maxBytes, signal)
}

/** Caller cancellation passes through; everything else becomes a {@link CodexUsageError}. */
function usageFailure(error: unknown, timeout: AbortSignal, caller: AbortSignal | undefined): unknown {
  if (caller?.aborted === true) return error
  if (timeout.aborted) {
    return new CodexUsageError('Codex usage request timed out', 'CODEX_USAGE_TIMEOUT', undefined, { cause: error })
  }
  if (error instanceof CodexUsageError) return error
  return new CodexUsageError('Codex usage request failed before a complete response', 'CODEX_USAGE_NETWORK',
    undefined, { cause: error })
}

/** Tokens for the request; credential errors keep their type, only the shared deadline is reported as ours. */
async function usageTokens(
  options: GetCodexUsageOptions, signal: AbortSignal, timeout: AbortSignal,
): Promise<CodexTokens> {
  try {
    return await getCodexTokens(options.authStore, { ...options.oauth, signal })
  } catch (error: unknown) {
    throw timeout.aborted && options.signal?.aborted !== true ? usageFailure(error, timeout, options.signal) : error
  }
}

/**
 * Fetch the account's current Codex usage: remaining share of each plan window,
 * when each resets, credits, and which models are available.
 *
 * Reading usage does not consume any. Tokens are refreshed when due, exactly as a
 * model request would. Personal identifiers in the response are not returned.
 *
 * @throws {CodexUsageError} for any failure of the usage request itself; see its `code`s.
 * @throws the credential store's error when no tokens are stored, or `CodexRefreshError`
 *   when due tokens cannot be refreshed. Caller cancellation rethrows the signal's reason.
 */
export async function getCodexUsage(options: GetCodexUsageOptions): Promise<CodexUsage> {
  const url = codexUsageUrl(options.baseUrl)
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'usage timeoutMs')
  const maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'usage maxBytes')
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Codex usage requires fetch')
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  const tokens = await usageTokens(options, signal, timeout)
  const headers = usageHeaders(tokens, options.originator ?? CODEX_ORIGINATOR)
  try {
    return await requestUsage({ url, headers, fetchImpl, maxBytes }, signal)
  } catch (error: unknown) {
    throw usageFailure(error, timeout, options.signal)
  }
}
