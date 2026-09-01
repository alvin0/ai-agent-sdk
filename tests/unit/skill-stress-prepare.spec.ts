import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSkillStressCommandRequest,
  hashSkillDirectory,
  prepareSkillStressFixtures,
  type SkillStressCommandRunner,
} from '../../test-human/skill-stress/prepare.ts'
import {
  parseSkillStressSourceLock,
  skillsCliAddArguments,
  type SkillStressSourceLock,
} from '../../test-human/skill-stress/sources.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('skill-stress source acquisition', () => {
  it('parses a pinned source and creates a non-global, telemetry-free CLI request', () => {
    const lock = makeLock('0'.repeat(64), 1)
    const source = lock.sources[0]!
    const request = createSkillStressCommandRequest(lock, source, 'C:/staging', 'C:/cache')

    expect(Object.isFrozen(lock)).toBe(true)
    expect(Object.isFrozen(lock.sources)).toBe(true)
    expect(skillsCliAddArguments(lock, source)).toEqual([
      '--yes',
      'skills@1.5.23',
      'add',
      `https://github.com/example/skills/archive/${'a'.repeat(40)}.zip`,
      '--skill',
      'fixture-skill',
      '--agent',
      'codex',
      '--copy',
      '-y',
    ])
    expect(request.args).not.toContain('-g')
    expect(request.env.DISABLE_TELEMETRY).toBe('1')
    expect(request.env.DO_NOT_TRACK).toBe('1')
    expect(request.env.npm_config_ignore_scripts).toBe('true')
    expect(request.env.npm_config_cache).toMatch(/[\\/]cache$/)
  })

  it('rejects floating Git sources before running npx', () => {
    const raw = rawLock('0'.repeat(64), 1)
    raw.sources[0]!.source = 'https://github.com/example/skills.git'
    expect(() => parseSkillStressSourceLock(raw)).toThrow(/commit archive or explicit Git tag/)

    raw.sources[0]!.source = 'https://github.com/example/skills.git#main'
    expect(() => parseSkillStressSourceLock(raw)).toThrow(/version tag or contain its commit/)
  })

  it('hashes relative paths and contents deterministically', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'references'), { recursive: true })
    await writeFile(join(root, 'SKILL.md'), 'main')
    await writeFile(join(root, 'references', 'guide.md'), 'guide')

    const expected = createHash('sha256')
      .update('SKILL.md')
      .update('main')
      .update('references/guide.md')
      .update('guide')
      .digest('hex')
    const digest = await hashSkillDirectory(root)

    expect(digest).toEqual({ computedHash: expected, fileCount: 2, totalBytes: 9 })
  })

  it('publishes verified files once and reuses the project-local cache', async () => {
    const root = await temporaryRoot()
    const seed = join(root, 'seed')
    await mkdir(join(seed, 'references'), { recursive: true })
    await writeFile(join(seed, 'SKILL.md'), 'fixture instructions')
    await writeFile(join(seed, 'references', 'details.md'), 'lazy details')
    const digest = await hashSkillDirectory(seed)
    const lock = makeLock(digest.computedHash, digest.fileCount)
    let calls = 0
    const runner: SkillStressCommandRunner = async request => {
      calls++
      const destination = join(request.cwd, '.agents', 'skills', 'fixture-skill')
      await mkdir(join(destination, 'references'), { recursive: true })
      await writeFile(join(destination, 'SKILL.md'), 'fixture instructions')
      await writeFile(join(destination, 'references', 'details.md'), 'lazy details')
      return { exitCode: 0, stdout: 'installed', stderr: '' }
    }
    const workspaceRoot = join(root, '.cache')

    const first = await prepareSkillStressFixtures({ lock, workspaceRoot, runner })
    expect(first.reused).toBe(false)
    expect(first.skillsRoot).toBe(join(workspaceRoot, 'skills'))
    expect(first.stagingRoot).toBeDefined()
    expect(calls).toBe(1)
    await first.cleanup()

    const failIfCalled: SkillStressCommandRunner = async () => {
      throw new Error('runner should not execute when the cache is valid')
    }
    const second = await prepareSkillStressFixtures({ lock, workspaceRoot, runner: failIfCalled })
    expect(second.reused).toBe(true)
    expect(second.stagingRoot).toBeUndefined()
    expect(second.sources[0]?.computedHash).toBe(digest.computedHash)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-skill-stress-'))
  roots.push(root)
  return root
}

function makeLock(computedHash: string, fileCount: number): SkillStressSourceLock {
  return parseSkillStressSourceLock(rawLock(computedHash, fileCount))
}

function rawLock(computedHash: string, fileCount: number): {
  version: number
  cli: { package: string; version: string }
  sources: Array<Record<string, unknown>>
} {
  return {
    version: 1,
    cli: { package: 'skills', version: '1.5.23' },
    sources: [{
      id: 'fixture-skill',
      skill: 'fixture-skill',
      source: `https://github.com/example/skills/archive/${'a'.repeat(40)}.zip`,
      revision: 'a'.repeat(40),
      registry: 'https://skills.sh/example/skills/fixture-skill',
      computedHash,
      fileCount,
    }],
  }
}
