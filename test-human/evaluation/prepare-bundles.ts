/** Reversible isolated checkouts; preserves the caller's staged/working tree. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { requireIntegrityEntries } from './integrity.ts'
import { stagedDiffHash } from './staged-integrity.ts'

const execute = promisify(execFile)
const args = process.argv.slice(2)
const option = (name: string, fallback = '') => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1] ?? fallback }
const baseline = resolve(option('baseline', 'artifacts/neutral-evaluation/codex-luna-baseline-20260926-v1'))
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const sums = JSON.parse(await readFile(resolve(baseline, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
requireIntegrityEntries(sums, ['sdk-source.tar', 'sdk.patch', 'manifest.json', 'fixtures.json'])
for (const [file, sum] of Object.entries(sums)) {
  if (file.includes('..') || file.startsWith('/') || hash(await readFile(resolve(baseline, file))) !== sum) throw new Error('Frozen baseline integrity mismatch')
}
const manifest = JSON.parse(await readFile(resolve(baseline, 'manifest.json'), 'utf8')) as { sdkRevision: string }
if (!/^[a-f0-9]{40}$/.test(manifest.sdkRevision) || (await readFile(resolve(baseline, 'sdk.patch'))).length !== 0) throw new Error('This preparation requires a committed original baseline; dirty baseline needs an explicit patch composition')
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const outputOption = option('output')
const root = outputOption ? resolve(outputOption) : await mkdtemp(resolve(artifacts, 'bundle-preparation-'))
const taskRelative = relative(artifacts, root)
if (!taskRelative || taskRelative === '..' || taskRelative.startsWith(`..${sep}`) || taskRelative.startsWith(sep)) throw new Error('Prepared bundles must use a new directory inside artifacts')
if (outputOption) await mkdir(root) // Never overwrite or clean an existing directory.
const patch = (await execute('git', ['diff', '--binary', manifest.sdkRevision, '--', 'packages', 'samples'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout
const stagedSha256 = await stagedDiffHash()
await writeFile(resolve(root, 'candidate.patch'), patch, { flag: 'wx' })
const preparation = { root: relative(process.cwd(), root), baselineArchiveSha256: sums['sdk-source.tar'], baselineRevision: manifest.sdkRevision,
  candidatePatchSha256: hash(patch), stagedSha256, preparedAt: new Date().toISOString(), status: 'preparing' }
await writeFile(resolve(root, 'preparation.json'), JSON.stringify(preparation, null, 2), { flag: 'wx' })
for (const name of ['baseline-sdk', 'candidate-sdk']) {
  const sdkRoot = resolve(root, name)
  await mkdir(sdkRoot)
  await execute('tar', ['-xf', resolve(baseline, 'sdk-source.tar'), '-C', sdkRoot])
  if (name === 'candidate-sdk') {
    const prefix = relative(process.cwd(), sdkRoot)
    await execute('git', ['apply', '--unsafe-paths', `--directory=${prefix}`, resolve(root, 'candidate.patch')])
  }
  // Credentials are only read by the provider at run time, never copied here.
  await execute('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], { cwd: sdkRoot, maxBuffer: 32 * 1024 * 1024 })
  const build = await execute('pnpm', ['build'], { cwd: sdkRoot, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(resolve(root, `${name}-build.log`), build.stdout + build.stderr, { flag: 'wx' })
  await access(resolve(sdkRoot, 'packages/core/dist/agent/define/session.js'))
}
if (await stagedDiffHash() !== preparation.stagedSha256) throw new Error('The index changed during preparation; retain snapshots and inspect the user change')
await writeFile(resolve(root, 'preparation.json'), JSON.stringify({ ...preparation, status: 'built' }, null, 2))
console.log(JSON.stringify({ root, candidatePatchSha256: preparation.candidatePatchSha256, stagedPreserved: true }))
