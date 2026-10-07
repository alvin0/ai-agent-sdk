import { assertUsableApiKey } from '@alvin0/ai-agent-sdk-core'
import {
  CREDENTIAL_CAPABILITY_API_VERSION, type CredentialInput, type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import type { TypesafeAdapterOptions } from './types.ts'

export const CAPABILITIES = Object.freeze({
  questionTypes: Object.freeze(['choice', 'score', 'boolean'] as const),
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
})
export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
})

export function bound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new Error(
    `Invalid TypeSafe ${name}`)
  return result
}

export function typesafeBaseUrl(options: TypesafeAdapterOptions): URL {
  const url = new URL(options.baseUrl ?? 'https://api.typesafe.ai/v1')
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(
    url.protocol === 'http:' && options.allowInsecureHttp === true))) throw new Error(
      'TypeSafe requires an HTTPS API root without credentials, query or fragment')
  return url
}

export function captureCredential(
  input: CredentialInput,
): string | ((signal: AbortSignal, logger: SdkLogger) => Promise<string>) {
  if (typeof input === 'string') return assertUsableApiKey(input, 'TypeSafe', 'apiKey')
  else {
    const source = input
    if (source?.kind !== 'credential-source' || source.apiVersion !== CREDENTIAL_CAPABILITY_API_VERSION ||
      typeof source.resolve !== 'function') throw new Error('TypeSafe requires a compatible credential source')
    const resolve = source.resolve.bind(source)
    return async (signal, logger) => assertUsableApiKey(await resolve({ signal, logger }), 'TypeSafe',
      'credential source')
  }
}
