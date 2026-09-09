import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SdkLogger, SkillReference } from '@ai-agent-sdk/core/skills'
import { fileSystemSkillProviderPlugin } from '@ai-agent-sdk/skill-filesystem'

const temporary: string[] = []

function loggerStub(): SdkLogger {
  const logger: SdkLogger = {
    child: () => logger,
    trace: () => undefined, debug: () => undefined, info: () => undefined,
    warn: () => undefined, error: () => undefined, fatal: () => undefined,
  }
  return logger
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-filesystem-plugin-'))
  temporary.push(root)
  const directory = join(root, 'research')
  mkdirSync(directory)
  const skillFile = join(directory, 'SKILL.md')
  writeFileSync(skillFile, [
    '---', 'name: research', 'description: Research a topic.', '---',
    'Read sources before reporting.', '',
  ].join('\n'))
  writeFileSync(join(directory, 'notes.md'), 'fixture notes\n')
  return { root, skillFile }
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('filesystem skill provider plugin', () => {
  it('is inert, revisioned, restart-resolvable and rejects a stale locator', async () => {
    const { root, skillFile } = fixture()
    const io: unknown[] = []
    const plugin = fileSystemSkillProviderPlugin({ roots: [root], onIo: event => io.push(event) })
    expect(plugin).toMatchObject({ kind: 'skill-provider', apiVersion: 1, id: 'filesystem' })
    expect(io).toEqual([])

    const options = { signal: new AbortController().signal, logger: loggerStub() }
    const catalog = await plugin.list(options)
    expect(catalog.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(catalog.candidates.map(candidate => candidate.id)).toEqual(['research'])
    const candidate = catalog.candidates[0]
    if (candidate === undefined) throw new Error('missing fixture candidate')
    const reference: SkillReference = {
      id: candidate.id, source: candidate.source, provider: candidate.provider,
      catalogRevision: catalog.revision,
      ...(candidate.locator === undefined ? {} : { locator: candidate.locator }),
    }
    expect((await plugin.load(reference, options))?.instructions).toContain('Read sources')
    await expect(plugin.readResource?.(reference, 'notes.md', options)).resolves.toBe('fixture notes')

    const restarted = fileSystemSkillProviderPlugin({ roots: [root] })
    await expect(restarted.load(reference, options)).resolves.toMatchObject({ id: 'research' })

    writeFileSync(skillFile, [
      '---', 'name: research', 'description: Research a changed topic.', '---',
      'Changed instructions invalidate the old locator.', '',
    ].join('\n'))
    const changed = await restarted.list(options)
    expect(changed.revision).not.toBe(catalog.revision)
    await expect(restarted.load(reference, options)).resolves.toBeUndefined()
  })

  it('propagates cancellation before filesystem discovery', async () => {
    const { root } = fixture()
    const plugin = fileSystemSkillProviderPlugin({ roots: [root] })
    const controller = new AbortController()
    controller.abort(new Error('stop discovery'))
    expect(() => plugin.list({ signal: controller.signal, logger: loggerStub() }))
      .toThrow('stop discovery')
  })
})
