import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { verifyReleaseSource } from './release-source.mts'
import { basename, join } from 'node:path'

// Inspect the complete set before the first upload. A retry may reuse packages
// from an interrupted publish only when their tarballs are byte-for-byte identical.
const directory = process.argv[2] ?? 'artifacts'
const version = JSON.parse(readFileSync('packages/core/package.json', 'utf8')).version as string
const files = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
if (!files.length) throw new Error('No release tarballs')
const checks = await Promise.all(files.map(async filename => {
  const path = join(directory, filename)
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }))
  if (manifest.version !== version) throw new Error(`Unexpected version in ${filename}`)
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${version}`,
    { signal: AbortSignal.timeout(30000) })
  if (response.status === 404) return { filename, missing: true as const }
  if (!response.ok) throw new Error(`npm lookup failed for ${manifest.name} (HTTP ${response.status})`)
  const published = await response.json() as { dist?: { integrity?: string } }
  const digest = createHash('sha512').update(readFileSync(path)).digest()
  return { filename, missing: false as const, name: String(manifest.name), digest: digest.toString('hex'),
    identical: 'sha512-' + digest.toString('base64') === published.dist?.integrity }
}))
const pending = checks.filter(check => check.missing)
const tag = `refs/tags/v${version}`
const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', tag, tag + '^{}'], { encoding: 'utf8' }).trim()
const target = refs.split('\n').at(-1)?.split(/\s+/)[0]
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (pending.length && target && target !== head) throw new Error(`Version tag v${version} belongs to another commit`)
// Historical versions with an existing tag are a no-op. A partial upload or missing
// tag requires proof that every reused package came from this exact workflow commit.
if (!target || pending.length) {
  await Promise.all(checks.map(async check => {
    if (check.missing) return
    if (!check.identical) throw new Error(`Conflicting published tarball: ${check.filename}`)
    await verifyReleaseSource(check.name, version, check.digest, head, process.env.GITHUB_REPOSITORY ?? 'alvin0/ai-agent-sdk')
  }))
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `can_create_tag=${!target}\n`)
for (const { filename } of pending) process.stdout.write(`${basename(filename)}\n`)
