import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import { assertUsableApiKey } from '@alvin0/ai-agent-sdk-core'
import { observeCredentialOperation } from '../observation/operations.ts'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core/provider'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import type { CredentialSource, AuthScheme, HttpProviderOptions, ResolvedAuth } from './http-options.ts'

interface AuthHost {
  readonly displayName: string
  readonly options: Pick<HttpProviderOptions<object>, 'auth'>
}

export function unionByName(
  entries: readonly Readonly<Record<string, string>>[],
  kind: 'header' | 'query param',
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  const owners = new Map<string, number>()
  entries.forEach((entry, index) => {
    for (const [name, value] of Object.entries(entry)) {
      const lower = name.toLowerCase()
      const first = owners.get(lower)
      if (first !== undefined && first !== index) {
        throw new AgentSdkError(
          `Two auth schemes both produced the \`${lower}\` ${kind}`,
          HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION,
        )
      }
      owners.set(lower, index)
      output[name] = value
    }
  })
  return output
}

export function authSchemesOf(auth: AuthScheme | readonly AuthScheme[]): readonly AuthScheme[] {
  return Array.isArray(auth) ? auth : [auth as AuthScheme]
}

/** Resolve one credential source, with a useful label on failure. */
export async function credential(
  source: CredentialSource,
  displayName: string,
  label: string,
  operation: { signal: AbortSignal | undefined; context: ModelInvocationContext | undefined },
): Promise<string> {
  const { signal, context } = operation
  const value = typeof source === 'function' ? await source(signal, context) : source
  return assertUsableApiKey(value, displayName, label)
}

  /** Resolve one scheme for one operation, as either a header or a query param. */
export async function authSchemeResolved(
    host: AuthHost,
    auth: AuthScheme,
    provider: string,
    operation: { signal: AbortSignal | undefined; context: ModelInvocationContext | undefined },
  ): Promise<{ headers: Readonly<Record<string, string>>; query: Readonly<Record<string, string>> }> {
  const { signal, context } = operation
  switch (auth.kind) {
    case 'none':
      return { headers: {}, query: {} }
    case 'bearer': {
      const token = await observeCredentialOperation(context, provider, 'resolve', () => credential(
        auth.token, host.displayName, auth.label ?? 'the `auth.token` option', { signal, context },
      ))
      return { headers: { authorization: `Bearer ${token}` }, query: {} }
    }
    case 'header': {
      const value = await observeCredentialOperation(context, provider, 'resolve', () => credential(
        auth.value, host.displayName, auth.label ?? `the \`${auth.name}\` credential`, { signal, context },
      ))
      return { headers: { [auth.name]: value }, query: {} }
    }
    case 'query': {
      const value = await observeCredentialOperation(context, provider, 'resolve', () => credential(
        auth.value, host.displayName, auth.label ?? `the \`${auth.name}\` query credential`, { signal, context },
      ))
      return { headers: {}, query: { [auth.name]: value } }
    }
    case 'dynamic':
      return {
        headers: await observeCredentialOperation(
          context, provider, 'resolve', async () => await auth.resolve(signal, context, provider),
        ),
        query: {},
      }
    default:
      return { headers: {}, query: {} }
  }
}

  /**
   * Resolve every configured scheme in parallel and union their headers and
   * query params.
   *
   * Two schemes producing the same header name (or the same query param name)
   * fail fast, before the merged result ever reaches {@link mergeHeaderLayers}
   * — a collision here is a configuration mistake (the same credential
   * declared twice, or two schemes racing for `authorization`), not something
   * a later-layer-wins policy should paper over.
   */
export async function authHeaders(
    host: AuthHost,
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<ResolvedAuth> {
  const schemes = authSchemesOf(host.options.auth)
  const resolved = await Promise.all(
    schemes.map(scheme => authSchemeResolved(host, scheme, provider, { signal, context })),
  )
  const headers = unionByName(resolved.map(entry => entry.headers), 'header')
  const query = unionByName(resolved.map(entry => entry.query), 'query param')
  return { headers, query }
}

