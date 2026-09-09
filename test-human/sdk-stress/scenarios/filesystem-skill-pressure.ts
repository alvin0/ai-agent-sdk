import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCatalog } from '@alvin0/ai-agent-sdk-core/agent'
import { fileSystemSkills } from '@alvin0/ai-agent-sdk-skill-filesystem'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { StressChecks } from './shared.ts'

export async function filesystemSkillPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-human-skills-'))
  const external = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-human-external-'))
  const count = Math.min(context.iterations, 1_024)
  const io: Array<{ phase: string; operation: string; bytesRead: number; path: string }> = []
  try {
    await runWrites(root, count)
    await writeFile(join(external, 'secret.md'), 'outside-resource-probe', 'utf8')
    const escape = join(root, 'skill-0000', 'references', 'escape.md')
    await symlink(join(external, 'secret.md'), escape)
    const provider = fileSystemSkills({
      roots: [{ path: root, source: 'sdk-stress' }],
      maxCandidates: Math.max(1, count), maxRootEntries: Math.max(1, count),
      onIo: event => io.push(event),
    })
    const catalog = new SkillCatalog([provider])
    const candidates = await catalog.discover({ signal: context.signal })
    checks.equal('all bounded skill candidates are discovered', candidates.length, count)
    const selected = candidates.filter((_, index) => index % Math.max(1, Math.floor(count / 16)) === 0).slice(0, 16)
    let resourcesRead = 0
    for (const candidate of selected) {
      context.signal.throwIfAborted()
      const loaded = await catalog.activate(candidate.id, { signal: context.signal })
      if (loaded === undefined) continue
      const resource = await catalog.readResource(candidate.id, 'references/probe.md', { signal: context.signal })
      if (resource?.includes(`resource-${candidate.id}`) === true) resourcesRead++
    }
    checks.equal('only selected skill bodies/resources are activated and read', resourcesRead, selected.length)
    let escaped = false
    const first = candidates.find(candidate => candidate.id === 'skill-0000')
    if (first !== undefined) {
      try { await provider.readResource?.(first, 'references/escape.md', { signal: context.signal }) }
      catch { escaped = true }
    }
    checks.check('resource symlinks cannot escape the selected skill directory', escaped)

    const firstSkill = join(root, 'skill-0000', 'SKILL.md')
    await writeFile(firstSkill, skillDocument('skill-0000', 'updated-body-probe'), 'utf8')
    await catalog.discover({ signal: context.signal })
    checks.check('hot-edited skill bodies invalidate prior activation', !catalog.isActivated('skill-0000'))

    const abort = new AbortController()
    abort.abort(new DOMException('pre-aborted discovery', 'AbortError'))
    let abortObserved = false
    try { await provider.list({ signal: abort.signal }) } catch { abortObserved = true }
    checks.check('pre-aborted discovery stops before filesystem traversal', abortObserved)
    const discoveryReads = io.filter(event => event.phase === 'discovery' && event.operation === 'read').length
    const activationReads = io.filter(event => event.phase === 'activation' && event.operation === 'read').length
    const resourceReads = io.filter(event => event.phase === 'resource' && event.operation === 'read').length
    context.artifact.record('filesystem-skill-io', {
      count, selected: selected.map(candidate => candidate.id),
      discoveryReads, activationReads, resourceReads, ioEvents: io.length,
    })
    return Object.freeze({
      invariants: checks.items(),
      metrics: Object.freeze({ count, selected: selected.length, resourcesRead, discoveryReads, activationReads, resourceReads }),
    })
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ])
  }
}

async function runWrites(root: string, count: number): Promise<void> {
  const batch = 64
  for (let start = 0; start < count; start += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, count - start) }, async (_, offset) => {
      const index = start + offset
      const id = `skill-${index.toString().padStart(4, '0')}`
      const directory = join(root, id)
      await mkdir(join(directory, 'references'), { recursive: true })
      await Promise.all([
        writeFile(join(directory, 'SKILL.md'), skillDocument(id, `body-${id}`), 'utf8'),
        writeFile(join(directory, 'references', 'probe.md'), `resource-${id}\n`, 'utf8'),
      ])
    }))
  }
}

function skillDocument(id: string, body: string): string {
  return `---\nname: ${id}\ndescription: Deterministic stress skill ${id}.\n---\n${body}\n`
}
