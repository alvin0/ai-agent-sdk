import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_RESOURCE_CHARS,
  SkillCatalog,
  createSkillTools,
  resolveSkillOptions,
} from '../../src/agent/skill/index.ts'
import {
  discoverFileSystemSkills,
  fileSystemSkills,
} from '../../src/agent/skill/filesystem.ts'
import { dispatchToolCall } from '../../src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../src/agent/tool/registry.ts'
import { ToolCallId } from '../../src/core/primitives/brand.ts'

const observedReads = vi.hoisted(() => vi.fn<(path: string, bytes: number) => void>())
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: readonly unknown[]) => {
      const path = String(args[0])
      const handle = await Reflect.apply(actual.open, actual, args)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs: readonly unknown[]) => {
              const result = await Reflect.apply(target.read, target, readArgs) as { bytesRead: number }
              observedReads(path, result.bytesRead)
              return result
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('filesystem skill discovery', () => {
  it('discovers SKILL.md bundles and loads resources only on demand', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'incident-triage')
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---', 'name: incident-triage', 'description: Route production incidents.',
      'metadata:', '  when_to_use: An incident needs an owner.', '---',
      '# Workflow', 'Read references/severity.md only when severity is missing.', '',
    ].join('\n'))
    await writeFile(join(directory, 'references', 'severity.md'), '# Critical\nPage now.\n')

    const provider = fileSystemSkills({ roots: [{ path: root, source: 'project-agents' }] })
    const candidates = await provider.list({})

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'incident-triage', source: 'project-agents', provider: 'filesystem',
      description: 'Route production incidents.', whenToUse: 'An incident needs an owner.',
    })
    const loaded = await provider.load(candidates[0]!, {})
    expect(loaded?.instructions).toContain('Read references/severity.md')
    expect(loaded?.resources).toBeUndefined()
    expect(loaded?.resourceManifest).toEqual([
      { path: 'references/severity.md', sizeBytes: 21 },
    ])
    await expect(provider.readResource?.(
      candidates[0]!, 'references/severity.md', {},
    )).resolves.toBe('# Critical\nPage now.')
  })

  it('honors Codex implicit policy while keeping explicit user invocation available', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'manual-only')
    await mkdir(join(directory, 'agents'), { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---', 'name: manual-only', 'description: Use only when selected.', '---', 'Do the explicit workflow.',
    ].join('\n'))
    await writeFile(join(directory, 'agents', 'openai.yaml'), [
      'policy:', '  allow_implicit_invocation: false', '',
    ].join('\n'))

    const [candidate] = await fileSystemSkills({ roots: [root] }).list({})

    expect(candidate?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('rediscovers added folders and resolves duplicate ids by ordered root precedence', async () => {
    const near = await temporaryRoot()
    const far = await temporaryRoot()
    await writeSkill(far, 'same-skill', 'Far description')
    const provider = fileSystemSkills({ roots: [near, far] })

    expect((await provider.list({}))[0]?.description).toBe('Far description')
    await writeSkill(near, 'same-skill', 'Near description')
    expect((await provider.list({}))[0]?.description).toBe('Near description')
  })

  it('bounds root directory scanning before retaining an unbounded entry list', async () => {
    const root = await temporaryRoot()
    await Promise.all(['one', 'two', 'three'].map(name => mkdir(join(root, name))))
    const provider = fileSystemSkills({ roots: [root], maxRootEntries: 2 })
    await expect(provider.list({})).rejects.toThrow(/exceeds 2 entries/)
  })

  it('offers an eager discovery convenience and follows a configured directory link', async () => {
    const root = await temporaryRoot()
    const external = await temporaryRoot()
    await writeSkill(external, 'linked-skill', 'Linked description')
    const link = join(root, 'linked-skill')
    await symlink(join(external, 'linked-skill'), link, process.platform === 'win32' ? 'junction' : 'dir')

    const definitions = await discoverFileSystemSkills({ roots: [root] })

    expect(definitions.map(skill => skill.id)).toEqual(['linked-skill'])
    expect(definitions[0]?.resourceBase).toMatchObject({ kind: 'directory' })
  })

  it('reads only front matter during discovery and bounds the body when that skill is selected', async () => {
    const root = await temporaryRoot()
    const oversizedDirectory = join(root, 'oversized-body')
    await mkdir(oversizedDirectory, { recursive: true })
    const oversizedPath = join(oversizedDirectory, 'SKILL.md')
    await writeFile(oversizedPath, [
      '---', 'name: oversized-body', 'description: Metadata remains cheap.', '---',
      'x'.repeat(MAX_SKILL_INSTRUCTIONS_CHARS + 1), '',
    ].join('\n'))
    await writeSkill(root, 'small-body', 'A selectable small skill')
    const provider = fileSystemSkills({ roots: [root] })
    const catalog = new SkillCatalog([provider])

    observedReads.mockClear()
    const candidates = await catalog.discover()

    expect(candidates.map(candidate => candidate.id)).toEqual(['oversized-body', 'small-body'])
    expect(bytesReadFrom(oversizedPath)).toBeGreaterThan(0)
    expect(bytesReadFrom(oversizedPath)).toBeLessThan(MAX_SKILL_INSTRUCTIONS_CHARS)
    await expect(catalog.load('small-body')).resolves.toMatchObject({
      instructions: 'Follow the workflow.',
    })
    await expect(catalog.load('oversized-body')).rejects.toThrow(
      `exceed ${MAX_SKILL_INSTRUCTIONS_CHARS} characters`,
    )
  })

  it('invalidates activation when a same-path SKILL.md body changes', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'hot-edited')
    const skillPath = join(directory, 'SKILL.md')
    await mkdir(directory, { recursive: true })
    await writeFile(skillPath, [
      '---', 'name: hot-edited', 'description: Detect live workflow changes.', '---',
      'Original workflow.', '',
    ].join('\n'))
    const catalog = new SkillCatalog([fileSystemSkills({ roots: [root] })])

    await catalog.discover()
    await catalog.activate('hot-edited')
    expect(catalog.isActivated('hot-edited')).toBe(true)

    await writeFile(skillPath, [
      '---', 'name: hot-edited', 'description: Detect live workflow changes.', '---',
      'Updated workflow with a deliberately different byte length.', '',
    ].join('\n'))
    await catalog.discover()

    expect(catalog.isActivated('hot-edited')).toBe(false)
  })

  it('loads only the selected body and manifest, then reads one requested resource', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'lazy-resources')
    const references = join(directory, 'references')
    await mkdir(references, { recursive: true })
    const skillPath = join(directory, 'SKILL.md')
    const requestedPath = join(references, 'requested.md')
    const unrelatedPath = join(references, 'unrelated.md')
    await writeFile(skillPath, [
      '---', 'name: lazy-resources', 'description: Load resources progressively.', '---',
      'Read only the reference needed for the current request.', '',
    ].join('\n'))
    await writeFile(requestedPath, '# Requested\nOriginal value.\n')
    await writeFile(unrelatedPath, 'z'.repeat(MAX_SKILL_RESOURCE_CHARS + 1))
    const io: Array<{
      phase: string
      operation: string
      path: string
      bytesRead: number
    }> = []
    const provider = fileSystemSkills({ roots: [root], onIo: event => io.push(event) })
    const catalog = new SkillCatalog([provider])

    observedReads.mockClear()
    await catalog.discover()
    expect(io.some(event => event.phase === 'discovery'
      && event.operation === 'read' && event.path === skillPath && event.bytesRead > 0)).toBe(true)
    expect(io.some(event => event.phase !== 'discovery')).toBe(false)
    const loaded = await catalog.activate('lazy-resources')

    expect(loaded?.resources).toEqual({})
    expect(loaded?.resourceManifest.map(resource => resource.path)).toEqual([
      'references/requested.md', 'references/unrelated.md',
    ])
    expect(bytesReadFrom(requestedPath)).toBe(0)
    expect(bytesReadFrom(unrelatedPath)).toBe(0)
    expect(io.some(event => event.phase === 'activation'
      && event.operation === 'read' && event.path === skillPath && event.bytesRead > 0)).toBe(true)
    expect(io.some(event => event.phase === 'resource')).toBe(false)

    await catalog.discover()
    expect(catalog.isActivated('lazy-resources')).toBe(true)

    // A post-load edit must be visible: the old contents were never cached in the definition.
    await writeFile(requestedPath, '# Requested\nFresh value.\n')
    observedReads.mockClear()
    const registry = new ToolRegistry()
    for (const tool of createSkillTools(catalog, resolveSkillOptions(undefined), () => ({}))) {
      registry.register(tool)
    }
    const result = await dispatchToolCall({
      catalog: registry,
      call: {
        callId: ToolCallId('call-read-lazy-resource'),
        toolName: 'read_skill_resource',
        rawArguments: JSON.stringify({
          skillId: 'lazy-resources', path: 'references/requested.md', section: 'Requested',
        }),
      },
      position: { turn: 1, step: 1 }, signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: false, value: '# Requested\nFresh value.' })
    expect(bytesReadFrom(requestedPath)).toBeGreaterThan(0)
    expect(bytesReadFrom(unrelatedPath)).toBe(0)
    expect(io.some(event => event.phase === 'resource'
      && event.operation === 'read' && event.path === requestedPath && event.bytesRead > 0)).toBe(true)
    expect(io.some(event => event.phase === 'resource' && event.path === unrelatedPath)).toBe(false)
  })
})

function bytesReadFrom(path: string): number {
  return observedReads.mock.calls.reduce(
    (total, [observedPath, bytes]) => total + (observedPath === path ? bytes : 0), 0,
  )
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-skills-'))
  cleanup.push(root)
  return root
}

async function writeSkill(root: string, id: string, description: string): Promise<void> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---', `name: ${id}`, `description: ${description}`, '---', 'Follow the workflow.', '',
  ].join('\n'))
}
