import { assertUsableApiKey, ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import { CREDENTIAL_CAPABILITY_API_VERSION, type CredentialInput, type ModelInvocationContext,
  type SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import type { OpenAiDecisionAdapterOptions } from './types.ts'

export const CAPABILITIES = Object.freeze({
  questionTypes: Object.freeze(['choice', 'score', 'boolean'] as const),
})
export function bound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new Error(
    `Invalid OpenAI Decisions ${name}`)
  return result
}
export function baseUrl(options: OpenAiDecisionAdapterOptions): string {
  const url = new URL(options.baseUrl ?? 'https://api.openai.com/v1')
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(
    url.protocol === 'http:' && options.allowInsecureHttp === true))) throw new Error(
      'OpenAI Decisions requires an HTTPS API root without credentials, query or fragment')
  return url.href.replace(/\/+$/, '')
}
export function captureCredential(
  input: CredentialInput,
): string | ((signal: AbortSignal, logger: SdkLogger) => Promise<string>) {
  if (typeof input === 'string') return assertUsableApiKey(input, 'OpenAI Decisions', 'apiKey')
  if (input?.kind !== 'credential-source' || input.apiVersion !== CREDENTIAL_CAPABILITY_API_VERSION ||
    typeof input.resolve !== 'function') throw new Error('OpenAI Decisions requires a compatible credential source')
  const resolve = input.resolve.bind(input)
  return async (signal, logger) => assertUsableApiKey(await resolve({ signal, logger }), 'OpenAI Decisions',
    'credential source')
}
export function captureHeaders(source?: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(source ?? {}).map(([name, value]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' ||
      /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new ModelError(
        'Invalid OpenAI Decisions headers', MODEL_ERROR_CODES.INVALID_REQUEST)
    const key = name.toLowerCase()
    if (['authorization', 'content-type', 'accept', 'host', 'content-length', 'traceparent'].includes(key)) {
      throw new ModelError('OpenAI Decisions headers cannot override transport headers',
        MODEL_ERROR_CODES.INVALID_REQUEST)
    }
    return [key, value.trim()] as const
  })
  return Object.freeze(Object.fromEntries(entries))
}

export function invocationHeaders(context?: ModelInvocationContext): Readonly<Record<string, string>> {
  if (context?.providerOptions?.body !== undefined && Object.keys(context.providerOptions.body).length) {
    throw new ModelError('OpenAI Decisions does not support body overrides', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  return captureHeaders(context?.providerOptions?.headers)
}
export function safetyIdentifier(value: string | undefined): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 128)) throw new Error(
    'Invalid OpenAI Decisions safetyIdentifier')
  return value
}
