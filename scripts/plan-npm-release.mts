import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
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
  if (response.status === 404) return { filename, missing: true, identical: false }
  if (!response.ok) throw new Error(`npm lookup failed for ${manifest.name} (HTTP ${response.status})`)
  const published = await response.json() as { dist?: { integrity?: string } }
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64')
  return { filename, missing: false, identical: integrity === published.dist?.integrity }
}))
const pending = checks.filter(check => check.missing)
if (pending.length) {
  const tag = `refs/tags/v${version}`
  const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', tag, tag + '^{}'], { encoding: 'utf8' }).trim()
  const target = refs.split('\n').at(-1)?.split(/\s+/)[0]
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (target && target !== head) throw new Error(`Version tag v${version} belongs to another commit`)
  for (const check of checks) {
    if (!check.missing && !check.identical) throw new Error(`Conflicting published tarball: ${check.filename}`)
  }
}
for (const { filename } of pending) process.stdout.write(`${basename(filename)}\n`)
