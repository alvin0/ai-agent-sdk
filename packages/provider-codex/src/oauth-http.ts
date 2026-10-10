import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { rejectCodexRedirect } from './common/no-follow.ts'
import { DEFAULT_CODEX_ISSUER, CODEX_CLIENT_ID, type CodexOAuthOptions } from './oauth-types.ts'

export function issuerOf(options: CodexOAuthOptions): string {
  const url = new URL(options.issuer ?? DEFAULT_CODEX_ISSUER)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Codex OAuth issuer must not contain credentials')
  }
  if (url.protocol !== 'https:' && !(options.allowInsecureIssuer === true && url.protocol === 'http:')) {
    throw new TypeError('Codex OAuth issuer must use https')
  }
  return url.href.replace(/\/+$/, '')
}

export function clientIdOf(options: CodexOAuthOptions): string {
  return options.clientId ?? CODEX_CLIENT_ID
}

export async function oauthFetch(
  options: CodexOAuthOptions,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const issuer = new URL(issuerOf(options))
  const url = new URL(input)
  if (url.origin !== issuer.origin) throw new TypeError(`Codex OAuth endpoint origin '${url.origin}' is not allowed`)
  const timeoutMs = positiveSafeInteger(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs')
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Codex OAuth requires fetch')
  const response = await raceAbort(Promise.resolve(fetchImpl(url, {
    ...init,
    signal,
    redirect: 'manual',
  })), signal)
  await rejectCodexRedirect(response, url.href, 'OAuth', 30_000)
  return response
}

export async function readResponseText(response: Response, options: CodexOAuthOptions): Promise<string> {
  const maxBytes = positiveSafeInteger(options.maxResponseBytes ?? 1024 * 1024, 'maxResponseBytes')
  const maxChunks = positiveSafeInteger(options.maxResponseChunks ?? 10_000, 'maxResponseChunks')
  await checkDeclaredSize(response, maxBytes)
  if (response.body === null) return ''
  const signal = responseSignal(options)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let chunks = 0
  let result = ''
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) return result + decoder.decode()
      if (next.value === undefined) continue
      chunks++
      bytes += next.value.byteLength
      if (chunks > maxChunks || bytes > maxBytes) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex OAuth response exceeds its configured resource limit`)
      }
      result += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error('Codex OAuth operation aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Codex OAuth operation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Codex OAuth ${field} must be a positive safe integer`)
  }
  return value
}

/** Read a JSON body, failing with the status when it is not JSON. */
export async function readJson(
  response: Response,
  what: string,
  options: CodexOAuthOptions,
): Promise<Record<string, unknown>> {
  const raw = await readResponseText(response, options)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error: unknown) {
    throw new AgentSdkError(
      `${what} returned a non-JSON response (HTTP ${response.status})`,
      'CODEX_AUTH_MALFORMED',
      { cause: error },
    )
  }
}

export function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentSdkError(`${what} omitted "${key}"`, 'CODEX_AUTH_MALFORMED')
  }
  return value
}

async function checkDeclaredSize(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
    throw new RangeError(`Codex OAuth response exceeds the ${maxBytes}-byte limit`)
  }
}

function responseSignal(options: CodexOAuthOptions): AbortSignal {
  const timeout = AbortSignal.timeout(positiveSafeInteger(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs'))
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
}
