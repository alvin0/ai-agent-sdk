import { execFile } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const humanCli = resolve('dist-cli/human.mjs')

describe('compiled CLI entry points', () => {
  it('renders help through the same JavaScript entry users execute', async () => {
    const result = await execFileAsync(process.execPath, [humanCli, '--help'])
    expect(result.stdout).toContain('Usage')
  })

  it('performs a Codex dry run without network or credential writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-cli-smoke-'))
    const authPath = join(cwd, '.providers/.codex/auth.json')
    const result = await execFileAsync(process.execPath, [
      humanCli,
      '--dry-run',
      '--provider', 'codex',
      '--model', 'gpt-5.6-luna',
    ], {
      cwd,
      env: { ...process.env, AI_AGENT_SDK_CODEX_AUTH: authPath },
    })
    expect(result.stdout).toContain('gpt-5.6-luna')
    await expect(access(authPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
