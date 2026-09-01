import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stripCommandSeparators } from '../../test-human/cli-args.ts'
import { parseSdkStressArgs, profileIterations } from '../../test-human/sdk-stress/config.ts'
import { runSdkStress, selectSdkStressScenarios } from '../../test-human/sdk-stress/runner.ts'
import { parseSkillStressArgs } from '../../test-human/skill-stress/config.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SDK human stress configuration', () => {
  it('accepts npm and pnpm separator forms without changing the command', () => {
    expect(stripCommandSeparators(['--', 'run', '--', '--profile', 'stress']))
      .toEqual(['--profile', 'stress'])
    expect(parseSdkStressArgs(
      ['--', 'run', '--', '--profile', 'stress', '--scenario', 'stream-assembly-pressure', '--seed', '17'],
      '/workspace',
    )).toMatchObject({ profile: 'stress', scenarioIds: ['stream-assembly-pressure'], seed: 17 })
    expect(parseSkillStressArgs(['--', 'run', '--', '--suite', 'offline'], '/workspace', {}))
      .toMatchObject({ suite: 'offline' })
  })

  it('scales monotonically and rejects unknown scenarios before executing', () => {
    expect(profileIterations('complex')).toBeLessThan(profileIterations('stress'))
    expect(profileIterations('stress')).toBeLessThan(profileIterations('soak'))
    const config = parseSdkStressArgs(['--scenario', 'not-real'], '/workspace')
    expect(() => selectSdkStressScenarios(config)).toThrow(/unknown sdk stress scenario/)
  })

  it('rejects unsafe artifact paths and invalid concurrency', () => {
    expect(() => parseSdkStressArgs(['--run-id', '../escape'], '/workspace')).toThrow(/safe path segment/)
    expect(() => parseSdkStressArgs(['--parallel', '0'], '/workspace')).toThrow(/positive integer/)
  })

  it('runs a selected customer journey and emits root and case artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-stress-test-'))
    cleanup.push(root)
    const config = parseSdkStressArgs([
      '--profile', 'complex', '--scenario', 'stream-assembly-pressure',
      '--seed', '17', '--run-id', 'unit-run', '--results-root', root,
    ], '/workspace')
    const summary = await runSdkStress(config)
    expect(summary).toMatchObject({ passed: 1, failed: 0, aborted: 0, totalIterations: 128 })
    expect(JSON.parse(await readFile(join(root, 'unit-run', 'summary.json'), 'utf8')))
      .toMatchObject({ runId: 'unit-run', passed: 1 })
    expect(JSON.parse(await readFile(summary.cases[0]?.artifact ?? '', 'utf8')))
      .toMatchObject({ status: 'passed', artifact: { droppedRecords: 0 } })
  })
})
