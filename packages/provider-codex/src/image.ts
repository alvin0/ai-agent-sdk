import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from './adapter-types.ts'
import { isFedrampAccount, resolveAccountId, type CodexTokens } from './auth.ts'
import { positiveSafeInteger, raceAbort, readCatalogJson } from './catalog.ts'
import { rejectCodexRedirect } from './common/no-follow.ts'
import { CodexImageError, parseCodexImageBody } from './image-response.ts'
import { getCodexTokens } from './oauth.ts'
import type { CodexImageResult, GenerateCodexImageOptions } from './image-types.ts'

export { CodexImageError } from './image-response.ts'

/** Same relative route used by Codex's standalone Images client. */
export function codexImageUrl(baseUrl = CODEX_BASE_URL): string {
  const url = new URL(baseUrl)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Codex Images base URL must not contain credentials')
  }
  if (url.protocol !== 'https:') throw new TypeError('Codex Images base URL must use https')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/images/generations`
  url.search = ''
  url.hash = ''
  return url.href
}

function requestBody(options: GenerateCodexImageOptions): string {
  for (const field of ['prompt', 'model'] as const) {
    if (typeof options[field] !== 'string' || options[field].trim().length === 0) {
      throw new TypeError(`Codex Images ${field} must be a non-empty string`)
    }
  }
  checkChoice(options.quality, ['auto', 'low', 'medium', 'high'], 'quality')
  checkChoice(options.size, ['auto', '1024x1024', '1536x1024', '1024x1536'], 'size')
  checkChoice(options.background, ['auto', 'opaque', 'transparent'], 'background')
  return JSON.stringify({
    model: options.model, prompt: options.prompt, n: 1,
    quality: options.quality ?? 'auto', size: options.size ?? 'auto', background: options.background ?? 'opaque',
  })
}

function checkChoice(value: string | undefined, choices: readonly string[], field: string): void {
  if (value !== undefined && !choices.includes(value)) throw new TypeError(`Invalid Codex Images ${field}`)
}

function imageHeaders(tokens: CodexTokens, originator: string): Record<string, string> {
  const accountId = resolveAccountId(tokens)
  return {
    authorization: `Bearer ${tokens.access_token}`, originator,
    version: CODEX_CLIENT_VERSION,
    'content-type': 'application/json', accept: 'application/json',
    'x-codex-image-turn-id': crypto.randomUUID(),
    ...(accountId === undefined ? {} : { 'chatgpt-account-id': accountId }),
    ...(isFedrampAccount(tokens) ? { 'x-openai-fedramp': 'true' } : {}),
  }
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 1_000)
}

function statusError(status: number): CodexImageError {
  if (status === 403) return new CodexImageError(
    'Codex Images access was forbidden for this connection; successful Codex chat does not establish Images access',
    'CODEX_IMAGE_FORBIDDEN', status,
  )
  const code = status === 401 ? 'CODEX_IMAGE_UNAUTHORIZED' : 'CODEX_IMAGE_HTTP'
  return new CodexImageError(`Codex Images request failed (HTTP ${status})`, code, status)
}

async function readImages(response: Response, maxBytes: number, signal: AbortSignal): Promise<CodexImageResult> {
  try {
    const body = await readCatalogJson(response, { maxBytes, maxChunks: 100_000, what: 'Images response' }, signal)
    return parseCodexImageBody(body)
  } catch (error: unknown) {
    await cancelBody(response)
    if (error instanceof RangeError) {
      throw new CodexImageError('Codex Images response exceeded its byte or chunk limit', 'CODEX_IMAGE_TOO_LARGE')
    }
    if (error instanceof SyntaxError
      || (error instanceof TypeError && error.message.startsWith('Codex Images response'))) {
      throw new CodexImageError('Codex Images response was not a JSON object', 'CODEX_IMAGE_MALFORMED')
    }
    throw error
  }
}

interface ImageRequest {
  readonly url: string
  readonly init: RequestInit
  readonly fetch: typeof globalThis.fetch
  readonly maxBytes: number
}

async function requestImages(request: ImageRequest, signal: AbortSignal): Promise<CodexImageResult> {
  const pending = Promise.resolve(request.fetch(request.url, { ...request.init, signal, redirect: 'manual' }))
  void pending.then(response => signal.aborted ? cancelBody(response) : undefined, () => undefined)
  const response = await raceAbort(pending, signal)
  try {
    await rejectCodexRedirect(response, request.url, 'Images', 1_000)
  } catch {
    throw new CodexImageError('Codex Images refused a redirect', 'CODEX_IMAGE_REDIRECT', response.status)
  }
  if (!response.ok) {
    await cancelBody(response)
    throw statusError(response.status)
  }
  return readImages(response, request.maxBytes, signal)
}

function imageFailure(error: unknown, timeout: AbortSignal, caller?: AbortSignal): unknown {
  if (caller?.aborted === true) return caller.reason
  if (timeout.aborted) return new CodexImageError('Codex Images request timed out', 'CODEX_IMAGE_TIMEOUT')
  if (error instanceof CodexImageError) return error
  return new CodexImageError('Codex Images request failed before a complete response', 'CODEX_IMAGE_NETWORK')
}

function imageCaller(options: GenerateCodexImageOptions): AbortSignal | undefined {
  const oauth = options.oauth?.signal
  return oauth && options.signal ? AbortSignal.any([oauth, options.signal]) : oauth ?? options.signal
}

function imageTimeout(value: number): number {
  const timeoutMs = positiveSafeInteger(value, 'Images timeoutMs')
  if (timeoutMs > 2_147_483_647) throw new RangeError('Codex Images timeoutMs exceeds the supported timer range')
  return timeoutMs
}

/**
 * Experimental: reuse Codex OAuth for a standalone Images request. Backend access
 * is independent of Responses and may return 403. No automatic retry or fallback.
 * Credentials refresh through the same store and CAS flow as chat requests.
 */
export async function generateCodexImage(options: GenerateCodexImageOptions): Promise<CodexImageResult> {
  const url = codexImageUrl(options.baseUrl)
  const body = requestBody(options)
  const timeoutMs = imageTimeout(options.timeoutMs ?? 180_000)
  const maxBytes = positiveSafeInteger(options.maxBytes ?? 32 * 1024 * 1024, 'Images maxBytes')
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Codex Images requires fetch')
  const timeout = AbortSignal.timeout(timeoutMs)
  const caller = imageCaller(options)
  const signal = caller === undefined ? timeout : AbortSignal.any([timeout, caller])
  let tokens: CodexTokens
  try {
    signal.throwIfAborted()
    tokens = await raceAbort(getCodexTokens(options.authStore, { ...options.oauth, signal }), signal)
  } catch (error: unknown) {
    if (signal.aborted) throw imageFailure(error, timeout, caller)
    throw error
  }
  try {
    signal.throwIfAborted()
    return await raceAbort(requestImages({ url, init: {
      method: 'POST', headers: imageHeaders(tokens, options.originator ?? CODEX_ORIGINATOR), body,
    }, fetch: fetchImpl, maxBytes }, signal), signal)
  } catch (error: unknown) {
    throw imageFailure(error, timeout, caller)
  }
}
