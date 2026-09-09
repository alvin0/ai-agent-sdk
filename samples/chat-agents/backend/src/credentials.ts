/**
 * Provider credentials entered in the UI.
 *
 * The SDK never reads environment variables, so a host must supply a
 * `CredentialSource`. This module is that host: keys are stored in SQLite and
 * handed to an adapter through a resolver, and environment variables act only
 * as a seed for a first run.
 */

import { eq } from 'drizzle-orm'
import { database, schema } from './db/client'

/** A provider's stored settings, as the UI is allowed to see them. */
export interface CredentialView {
  readonly provider: string
  /** True when a key is stored; the key itself is never returned. */
  readonly hasKey: boolean
  /** Last four characters, so the user can tell which key is installed. */
  readonly keyHint: string | undefined
  readonly baseUrl: string | undefined
  /** True when the key comes from the environment rather than the database. */
  readonly fromEnv: boolean
}

const ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  gemini: ['GEMINI_API_KEY', 'GEMINI_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
}

function envKey(provider: string): string | undefined {
  for (const name of ENV_KEYS[provider] ?? []) {
    const value = process.env[name]
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * Read one provider's stored key.
 * @param provider - Provider id.
 * @returns The key, falling back to the environment seed.
 */
export async function apiKeyFor(provider: string): Promise<string | undefined> {
  const { db } = database()
  const row = await db.select().from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.provider, provider)).all().then(rows => rows[0])
  const stored = row?.apiKey ?? undefined
  return stored !== undefined && stored.length > 0 ? stored : envKey(provider)
}

/**
 * Read one provider's endpoint override.
 * @param provider - Provider id.
 * @returns The base URL, or undefined to use the adapter default.
 */
export async function baseUrlFor(provider: string): Promise<string | undefined> {
  const { db } = database()
  const row = await db.select().from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.provider, provider)).all().then(rows => rows[0])
  const stored = row?.baseUrl ?? undefined
  return stored !== undefined && stored.length > 0 ? stored : undefined
}

/**
 * Describe every provider's stored settings without disclosing a key.
 * @param providers - Provider ids to describe.
 * @returns One view per provider.
 */
export async function credentialViews(
  providers: readonly string[],
): Promise<readonly CredentialView[]> {
  const { db } = database()
  const rows = await db.select().from(schema.providerCredentials).all()
  const byProvider = new Map(rows.map(row => [row.provider, row]))
  return providers.map((provider) => {
    const row = byProvider.get(provider)
    const stored = row?.apiKey ?? undefined
    const key = stored !== undefined && stored.length > 0 ? stored : envKey(provider)
    return {
      provider,
      hasKey: key !== undefined,
      keyHint: key === undefined ? undefined : `…${key.slice(-4)}`,
      baseUrl: row?.baseUrl ?? undefined,
      fromEnv: (stored === undefined || stored.length === 0) && key !== undefined,
    }
  })
}

/**
 * Store or clear a provider's key and endpoint.
 *
 * `apiKey`/`baseUrl` are tri-state: omitted leaves the value untouched, `null`
 * clears it, a string replaces it.
 * @param provider - Provider id.
 * @param input - The fields to change.
 */
export async function saveCredential(
  provider: string,
  input: { apiKey?: string | null; baseUrl?: string | null },
): Promise<void> {
  const { db } = database()
  const existing = await db.select().from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.provider, provider)).all().then(rows => rows[0])
  const next = {
    provider,
    apiKey: input.apiKey === undefined ? existing?.apiKey ?? null : input.apiKey,
    baseUrl: input.baseUrl === undefined ? existing?.baseUrl ?? null : input.baseUrl,
    updatedAt: Math.floor(Date.now() / 1000),
  }
  if (existing === undefined) {
    await db.insert(schema.providerCredentials).values(next).run()
    return
  }
  await db.update(schema.providerCredentials).set(next)
    .where(eq(schema.providerCredentials.provider, provider)).run()
}
