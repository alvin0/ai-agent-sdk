import type { DatabaseSync } from 'node:sqlite'
import { AgentSdkError, defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'

/**
 * Node SQLite example. Bind each store to one tenant and provider.
 * Production hosts own database access, encryption and account-level refresh locks.
 */
export function sqliteCredentialStore<Value>(
  database: DatabaseSync,
  tenantId: string,
  provider: 'codex' | 'copilot',
) {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0 || tenantId.includes('\0')) {
    throw new TypeError('A non-empty tenant scope is required')
  }
  if (provider !== 'codex' && provider !== 'copilot') {
    throw new TypeError('Unknown credential provider')
  }
  database.exec(`CREATE TABLE IF NOT EXISTS sdk_credentials (
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    value TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (tenant_id, provider)
  )`)
  const read = database.prepare(
    'SELECT value, revision FROM sdk_credentials WHERE tenant_id = ? AND provider = ?',
  )
  const insert = database.prepare(
    'INSERT INTO sdk_credentials (tenant_id, provider, value, revision) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
  const update = database.prepare(
    'UPDATE sdk_credentials SET value = ?, revision = ? WHERE tenant_id = ? AND provider = ? AND revision = ?',
  )
  return defineCredentialStore<Value>({
    id: provider + '-database',
    label: provider + ' database credentials',
    async read({ signal }) {
      signal.throwIfAborted()
      const row = read.get(tenantId, provider) as { value: string; revision: string } | undefined
      return row === undefined ? undefined : {
        value: JSON.parse(row.value) as Value, revision: row.revision,
      }
    },
    async commit(input, { signal }) {
      signal.throwIfAborted()
      const revision = globalThis.crypto.randomUUID()
      const value = JSON.stringify(input.value)
      if (value === undefined) throw new TypeError('Credential value must be JSON')
      const result = input.expectedRevision === null
        ? insert.run(tenantId, provider, value, revision)
        : update.run(value, revision, tenantId, provider, input.expectedRevision)
      if (Number(result.changes) !== 1) {
        throw new AgentSdkError('Credential revision changed before commit',
          provider === 'codex' ? 'CODEX_CREDENTIAL_REVISION_CONFLICT' : 'COPILOT_CREDENTIAL_REVISION_CONFLICT')
      }
      return { revision }
    },
  })
}
