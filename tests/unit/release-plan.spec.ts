import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/plan-npm-release.mts', import.meta.url))

it('checks bytes and npm source before recovering a fully published version with no tag', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'npm-recovery-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
      'commit', '-q', '--allow-empty', '-m', 'release')
    git('remote', 'add', 'origin', cwd)
    const head = git('rev-parse', 'HEAD')
    const manifest = JSON.stringify({ name: '@owner/core', version: '1.0.0' })
    for (const folder of ['packages/core', 'package', 'artifacts']) mkdirSync(join(cwd, folder), { recursive: true })
    for (const folder of ['packages/core', 'package']) writeFileSync(join(cwd, folder, 'package.json'), manifest)
    execFileSync('tar', ['czf', 'artifacts/core.tgz', 'package/package.json'], { cwd })
    const digest = createHash('sha512').update(readFileSync(join(cwd, 'artifacts/core.tgz'))).digest()
    const integrity = 'sha512-' + digest.toString('base64')
    const source = 'https://github.com/owner/sdk'
    const ref = 'refs/heads/main'
    const predicateType = 'https://slsa.dev/provenance/v1'
    function run(commit: string, registryIntegrity = integrity) {
      const statement = { predicateType, subject: [{ name: 'pkg:npm/%40owner/core@1.0.0', digest: { sha512: digest.toString('hex') } }],
        predicate: { buildDefinition: { externalParameters: { workflow: { ref, repository: source, path: '.github/workflows/release.yml' } },
          resolvedDependencies: [{ uri: 'git+' + source + '@' + ref, digest: { gitCommit: commit } }] } } }
      const payload = Buffer.from(JSON.stringify(statement)).toString('base64')
      const attestations = [{ predicateType, bundle: { dsseEnvelope: { payload } } }]
      const registry = join(cwd, 'registry.mjs')
      writeFileSync(registry, `globalThis.fetch = async url => Response.json(url.includes('/attestations/')
        ? ${JSON.stringify({ attestations })} : ${JSON.stringify({ dist: { integrity: registryIntegrity } })})`)
      const output = join(cwd, 'job-output')
      writeFileSync(output, '')
      const result = spawnSync(process.execPath, ['--import', registry, script, 'artifacts'], { cwd, encoding: 'utf8',
        env: { ...process.env, GITHUB_REPOSITORY: 'owner/sdk', GITHUB_OUTPUT: output } })
      return { code: result.status, error: result.stderr, pending: result.stdout, output: readFileSync(output, 'utf8') }
    }
    expect(run(head, 'sha512-conflict')).toMatchObject({ code: 1, error: expect.stringContaining('Conflicting published tarball'), output: '' })
    expect(run('b'.repeat(40))).toMatchObject({ code: 1, error: expect.stringContaining('no matching release provenance'), output: '' })
    expect(run(head)).toMatchObject({ code: 0, pending: '', output: 'can_create_tag=true\n' })
    git('-c', 'tag.gpgSign=false', 'tag', 'v1.0.0')
    expect(run(head, 'sha512-changed')).toMatchObject({ code: 0, pending: '', output: 'can_create_tag=false\n' })
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
