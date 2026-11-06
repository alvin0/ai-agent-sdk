import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexAccountAuthPath, fileCodexCredentialStore } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { copilotAccountAuthPath } from '@alvin0/ai-agent-sdk-auth-node/copilot'

describe('named provider accounts', () => {
  it('keeps each extra account in its own project-local file', () => {
    expect(codexAccountAuthPath('backup')).toBe('.providers/.codex/accounts/backup.json')
    expect(copilotAccountAuthPath('team-2')).toBe('.providers/.copilot/accounts/team-2.json')
  })

  it('refuses names that are not one safe path segment', () => {
    for (const name of ['', '../auth', 'a/b', '.hidden', 'a..b', 'x'.repeat(65)]) {
      expect(() => codexAccountAuthPath(name)).toThrow(TypeError)
      expect(() => copilotAccountAuthPath(name)).toThrow(TypeError)
    }
  })

  it('reads a named account through the file store at that path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'accounts-'))
    await mkdir(join(cwd, '.providers/.codex/accounts'), { recursive: true })
    const tokens = { id_token: 'a.b.c', access_token: 'a.b.c', refresh_token: 'r', account_id: null }
    await writeFile(join(cwd, codexAccountAuthPath('backup')), JSON.stringify({ tokens }), { mode: 0o600 })
    const record = await fileCodexCredentialStore(codexAccountAuthPath('backup'), { cwd })
      .read({ signal: new AbortController().signal, logger: undefined as never })
    expect(record?.value.tokens?.refresh_token).toBe('r')
  })
})
